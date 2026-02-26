package log

import (
	"os"
	"path/filepath"

	"github.com/rs/zerolog"
)

// DiagLogger оборачивает zerolog с поддержкой компонентных суб-логгеров для диагностики.
type DiagLogger struct {
	base zerolog.Logger
}

// Diag — глобальный диагностический логгер. Требует вызова InitDiag перед использованием.
var Diag DiagLogger

// InitDiag создаёт файл диагностического лога в configDir/logs/diag.log.
// Ротирует предыдущий лог в diag.log.1, если размер превышает 5MB.
func InitDiag(configDir string) error {
	logDir := filepath.Join(configDir, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return err
	}
	logPath := filepath.Join(logDir, "diag.log")

	// Простая ротация: переименовываем в .1 если > 5MB
	if info, err := os.Stat(logPath); err == nil && info.Size() > 5*1024*1024 {
		os.Rename(logPath, logPath+".1")
	}

	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	Diag = DiagLogger{
		base: zerolog.New(f).With().Timestamp().Logger(),
	}
	return nil
}

// Component возвращает суб-логгер с тегом указанного компонента.
func (d DiagLogger) Component(name string) zerolog.Logger {
	return d.base.With().Str("component", name).Logger()
}
