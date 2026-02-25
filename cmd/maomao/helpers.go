package main

import (
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/agent"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/tui"
	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// parkActiveTasks marks all active tasks as parked.
func parkActiveTasks() {
	tasks, _ := task.List()
	for _, t := range tasks {
		if t.Status == task.StatusActive {
			t.Status = task.StatusParked
			task.Save(t)
		}
	}
}

// buildTaskEntries creates TaskEntry slice from persisted tasks.
func buildTaskEntries() []tui.TaskEntry {
	tasks, _ := task.List()
	var entries []tui.TaskEntry
	for _, t := range tasks {
		title := t.Title
		if len(title) > 30 {
			title = title[:27] + "..."
		}
		var repoNames []string
		for _, r := range t.Repos {
			repoNames = append(repoNames, r.Name)
		}
		// Time tracking stats
		activeTime := ""
		todayTime := ""
		sessionCount := 0
		if stats, err := task.GetStats(t.ID); err == nil && stats.SessionCount > 0 {
			activeTime = task.FormatDuration(stats.TotalActiveSec)
			todayTime = task.FormatDuration(stats.TodayActiveSec)
			sessionCount = stats.SessionCount
		}

		entries = append(entries, tui.TaskEntry{
			ID:           t.ID,
			Type:         t.Type,
			Title:        title,
			Status:       t.Status,
			Active:       t.Status == task.StatusActive,
			Repos:        len(t.Repos),
			RepoNames:    repoNames,
			ActiveTime:   activeTime,
			TodayTime:    todayTime,
			SessionCount: sessionCount,
		})
	}
	return entries
}

// getLastOutputLines extracts the last 30 lines from a process's log buffer.
func getLastOutputLines(pm *process.ProcessManager, processKey string) []string {
	rp := pm.Get(processKey)
	if rp == nil || rp.LogBuf == nil {
		return nil
	}
	total := rp.LogBuf.Len()
	start := total - 30
	if start < 0 {
		start = 0
	}
	return rp.LogBuf.ReadRange(start, total)
}

// writeRepoSessionSummary writes session summary for a single repo (best-effort).
func writeRepoSessionSummary(pm *process.ProcessManager, taskID, repoName, worktreeDir string) {
	processKey := taskID + ":" + repoName
	lines := getLastOutputLines(pm, processKey)
	_ = agent.WriteSessionSummary(agent.SessionSummaryParams{
		WorktreeDir:     worktreeDir,
		LastOutputLines: lines,
		Timestamp:       time.Now(),
	})
}
