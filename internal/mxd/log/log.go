package log

import (
	"os"
	"path/filepath"

	"github.com/rs/zerolog"
)

var Logger zerolog.Logger

// Init создаёт файл логов и конфигурирует zerolog.
func Init(configDir string) error {
	logDir := filepath.Join(configDir, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return err
	}
	logPath := filepath.Join(logDir, "mxd.log")
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	Logger = zerolog.New(f).With().Timestamp().Logger()
	return nil
}
