package event

import "time"

// Type classifies an event in the system.
type Type string

const (
	// Task lifecycle
	TaskCreated   Type = "task.created"
	TaskOpened    Type = "task.opened"
	TaskParked    Type = "task.parked"
	TaskDeleted   Type = "task.deleted"
	TaskCompleted Type = "task.completed"

	// Agent lifecycle
	AgentStarted   Type = "agent.started"
	AgentStopped   Type = "agent.stopped"
	AgentCrashed   Type = "agent.crashed"
	AgentRestarted Type = "agent.restarted"
	AgentStale     Type = "agent.stale"

	// Cross-repo communication
	HandoffSent      Type = "handoff.sent"
	HandoffDelivered Type = "handoff.delivered"
	MessageSent      Type = "message.sent"

	// Story lifecycle (Iteration 3)
	StoryStarted Type = "story.started"
	StoryDone    Type = "story.done"
	StoryFailed  Type = "story.failed"
)

// Event represents a single logged event.
type Event struct {
	Timestamp time.Time `json:"ts"`
	Type      Type      `json:"event"`
	TaskID    string    `json:"task,omitempty"`
	Repo      string    `json:"repo,omitempty"`
	Detail    string    `json:"detail,omitempty"`
}

// New creates an Event with the current timestamp.
func New(t Type, taskID, repo, detail string) Event {
	return Event{
		Timestamp: time.Now(),
		Type:      t,
		TaskID:    taskID,
		Repo:      repo,
		Detail:    detail,
	}
}

// Icon returns a display icon for the event type.
func (e Event) Icon() string {
	switch e.Type {
	case AgentStarted, AgentRestarted:
		return "●"
	case AgentStopped:
		return "○"
	case AgentCrashed:
		return "✕"
	case AgentStale:
		return "⚠"
	case HandoffSent, HandoffDelivered:
		return "✦"
	case MessageSent:
		return "▸"
	case TaskCreated, TaskOpened:
		return "◆"
	case TaskParked:
		return "◇"
	case TaskDeleted:
		return "✕"
	case TaskCompleted:
		return "✓"
	case StoryStarted, StoryDone, StoryFailed:
		return "▪"
	default:
		return "·"
	}
}

// ShortLabel returns a concise human-readable label.
func (e Event) ShortLabel() string {
	repo := e.Repo
	if repo == "" {
		repo = e.TaskID
	}

	switch e.Type {
	case AgentStarted:
		return repo + " started"
	case AgentStopped:
		return repo + " stopped"
	case AgentCrashed:
		return repo + " crashed"
	case AgentRestarted:
		return repo + " restarted"
	case AgentStale:
		return repo + " stale"
	case HandoffSent:
		return "handoff → " + repo
	case HandoffDelivered:
		return "handoff → " + repo
	case MessageSent:
		return "msg → " + repo
	case TaskCreated:
		return "task created"
	case TaskOpened:
		return "task opened"
	case TaskParked:
		return "task parked"
	case TaskDeleted:
		return "task deleted"
	case TaskCompleted:
		return "task completed"
	default:
		return string(e.Type)
	}
}
