package config

// HooksConfig defines lifecycle hook commands.
// Each hook is a shell command string that gets executed at the corresponding lifecycle point.
// Empty string means no hook is configured.
type HooksConfig struct {
	OnTaskCreate string `toml:"on_task_create"`
	OnTaskOpen   string `toml:"on_task_open"`
	OnTaskPark   string `toml:"on_task_park"`
	OnAgentStart string `toml:"on_agent_start"`
	OnAgentStop  string `toml:"on_agent_stop"`
	PreMerge     string `toml:"pre_merge"`
	PostMerge    string `toml:"post_merge"`
}
