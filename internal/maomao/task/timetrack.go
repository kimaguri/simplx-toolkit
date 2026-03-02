package task

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/renameio/v2"
	toml "github.com/pelletier/go-toml/v2"
)

// TimeSession represents a single work session for a task.
type TimeSession struct {
	ID        string    `toml:"id"`
	StartedAt time.Time `toml:"started_at"`
	EndedAt   time.Time `toml:"ended_at"`   // zero if active
	ActiveSec int       `toml:"active_sec"` // excludes idle time
	Repos     []string  `toml:"repos"`      // which repos were active
	IdleSec   int       `toml:"idle_sec"`   // detected idle time
}

// TimeLog holds all time sessions for a task.
type TimeLog struct {
	Sessions []TimeSession `toml:"sessions"`
}

// TimeStats provides aggregated time statistics for display.
type TimeStats struct {
	TotalActiveSec int
	TotalIdleSec   int
	TodayActiveSec int
	SessionCount   int
	FirstSession   time.Time
	LastSession    time.Time
}

// timelogPath returns the path to a task's timelog.toml file.
func timelogPath(taskID string) string {
	return filepath.Join(TaskDir(taskID), "timelog.toml")
}

// LoadTimeLog loads the time log for a task. Returns empty TimeLog if not found.
func LoadTimeLog(taskID string) (*TimeLog, error) {
	path := timelogPath(taskID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &TimeLog{}, nil
		}
		return nil, fmt.Errorf("read timelog: %w", err)
	}
	var tl TimeLog
	if err := toml.Unmarshal(data, &tl); err != nil {
		return nil, fmt.Errorf("parse timelog: %w", err)
	}
	return &tl, nil
}

// SaveTimeLog persists the time log to disk atomically.
func SaveTimeLog(taskID string, tl *TimeLog) error {
	path := timelogPath(taskID)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create timelog dir: %w", err)
	}
	data, err := toml.Marshal(tl)
	if err != nil {
		return fmt.Errorf("marshal timelog: %w", err)
	}
	if err := renameio.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write timelog: %w", err)
	}
	return nil
}

// StartSession creates a new active time session for a task.
// Returns the session ID.
func StartSession(taskID string, repos []string) (string, error) {
	tl, err := LoadTimeLog(taskID)
	if err != nil {
		return "", err
	}

	// End any currently active session first
	endActiveSession(tl)

	sessionID := fmt.Sprintf("s%d", time.Now().UnixMilli())
	session := TimeSession{
		ID:        sessionID,
		StartedAt: time.Now(),
		Repos:     repos,
	}
	tl.Sessions = append(tl.Sessions, session)

	if err := SaveTimeLog(taskID, tl); err != nil {
		return "", err
	}
	return sessionID, nil
}

// EndSession closes the currently active session for a task.
func EndSession(taskID string) error {
	tl, err := LoadTimeLog(taskID)
	if err != nil {
		return err
	}
	endActiveSession(tl)
	return SaveTimeLog(taskID, tl)
}

// PauseSession pauses the currently active session (records time so far).
func PauseSession(taskID string) error {
	return EndSession(taskID)
}

// ResumeSession starts a new session (continuation of previous work).
func ResumeSession(taskID string, repos []string) (string, error) {
	return StartSession(taskID, repos)
}

// AddIdleTime adds idle seconds to the currently active session.
func AddIdleTime(taskID string, idleSec int) error {
	tl, err := LoadTimeLog(taskID)
	if err != nil {
		return err
	}
	if active := findActiveSession(tl); active != nil {
		active.IdleSec += idleSec
	}
	return SaveTimeLog(taskID, tl)
}

// GetStats computes aggregated time statistics for a task.
func GetStats(taskID string) (*TimeStats, error) {
	tl, err := LoadTimeLog(taskID)
	if err != nil {
		return nil, err
	}
	return computeStats(tl), nil
}

// GetTodayStats returns only today's active seconds for a task.
func GetTodayStats(taskID string) (int, error) {
	tl, err := LoadTimeLog(taskID)
	if err != nil {
		return 0, err
	}
	todayStart := todayMidnight()
	total := 0
	for i := range tl.Sessions {
		s := &tl.Sessions[i]
		if !s.StartedAt.Before(todayStart) {
			total += sessionActiveSec(s)
		}
	}
	return total, nil
}

// endActiveSession closes any active session in the time log.
func endActiveSession(tl *TimeLog) {
	for i := range tl.Sessions {
		if tl.Sessions[i].EndedAt.IsZero() {
			now := time.Now()
			tl.Sessions[i].EndedAt = now
			elapsed := int(now.Sub(tl.Sessions[i].StartedAt).Seconds())
			tl.Sessions[i].ActiveSec = elapsed - tl.Sessions[i].IdleSec
			if tl.Sessions[i].ActiveSec < 0 {
				tl.Sessions[i].ActiveSec = 0
			}
		}
	}
}

// findActiveSession returns the first active (no EndedAt) session, or nil.
func findActiveSession(tl *TimeLog) *TimeSession {
	for i := range tl.Sessions {
		if tl.Sessions[i].EndedAt.IsZero() {
			return &tl.Sessions[i]
		}
	}
	return nil
}

// sessionActiveSec returns the active seconds for a session.
// For active sessions, uses wall time minus idle. For ended, uses stored value.
func sessionActiveSec(s *TimeSession) int {
	if s.EndedAt.IsZero() {
		elapsed := int(time.Now().Sub(s.StartedAt).Seconds())
		active := elapsed - s.IdleSec
		if active < 0 {
			return 0
		}
		return active
	}
	return s.ActiveSec
}

// computeStats aggregates all sessions into TimeStats.
func computeStats(tl *TimeLog) *TimeStats {
	stats := &TimeStats{}
	todayStart := todayMidnight()

	for i := range tl.Sessions {
		s := &tl.Sessions[i]
		active := sessionActiveSec(s)
		stats.TotalActiveSec += active
		stats.TotalIdleSec += s.IdleSec
		stats.SessionCount++

		if stats.FirstSession.IsZero() || s.StartedAt.Before(stats.FirstSession) {
			stats.FirstSession = s.StartedAt
		}
		end := s.EndedAt
		if end.IsZero() {
			end = time.Now()
		}
		if end.After(stats.LastSession) {
			stats.LastSession = end
		}

		if !s.StartedAt.Before(todayStart) {
			stats.TodayActiveSec += active
		}
	}
	return stats
}

// todayMidnight returns today's midnight in local time.
func todayMidnight() time.Time {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day(),
		0, 0, 0, 0, now.Location())
}

// FormatDuration formats seconds into a human-readable duration string (e.g., "2h 47m").
func FormatDuration(totalSec int) string {
	if totalSec < 60 {
		return fmt.Sprintf("%ds", totalSec)
	}
	hours := totalSec / 3600
	minutes := (totalSec % 3600) / 60
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}
