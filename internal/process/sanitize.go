package process

import "bytes"

// sanitizeForLog strips terminal control sequences that don't render well
// in a scrollback log viewer. Keeps SGR (color/style) sequences intact.
//
// Special handling:
//   - CSI <n> C (Cursor Forward / CUF) → replaced with n spaces.
//   - CSI <n> A (Cursor Up / CUU) → removes last n lines from output.
//   - CSI J / CSI 0J (Erase Below / ED) → truncates output after current line.
//   - SGR sequences (final byte 'm') are preserved for colors.
//   - All other CSI sequences are stripped.
//   - OSC sequences (ESC ] ... BEL/ST) are stripped.
//   - Standalone \r → overwrites current line (truncates back to last \n).
//   - \r\n → \n.
//
// SanitizeForLog is the exported version for use by external packages (devdash).
func SanitizeForLog(data []byte) []byte {
	return sanitizeForLog(data)
}

func sanitizeForLog(data []byte) []byte {
	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		b := data[i]

		// ESC sequence
		if b == 0x1b && i+1 < len(data) {
			next := data[i+1]

			if next == '[' {
				// CSI sequence: ESC [ <params> <final byte>
				j := i + 2
				// Skip parameter bytes (0x30-0x3f) and intermediate bytes (0x20-0x2f)
				for j < len(data) && data[j] >= 0x20 && data[j] <= 0x3f {
					j++
				}
				// Skip intermediate bytes
				for j < len(data) && data[j] >= 0x20 && data[j] <= 0x2f {
					j++
				}
				if j < len(data) && data[j] >= 0x40 && data[j] <= 0x7e {
					finalByte := data[j]
					switch {
					case finalByte == 'm':
						// SGR (Select Graphic Rendition) — keep colors
						out = append(out, data[i:j+1]...)
					case finalByte == 'C':
						// CUF (Cursor Forward) — replace with spaces.
						n := parseCSIParam(data[i+2 : j])
						if n <= 0 {
							n = 1
						}
						out = append(out, bytes.Repeat([]byte{' '}, n)...)
					case finalByte == 'A':
						// CUU (Cursor Up) — remove last n rows from output.
						// Interactive menus use ESC[nA + ESC[J to redraw.
						n := parseCSIParam(data[i+2 : j])
						if n <= 0 {
							n = 1
						}
						out = cursorUpTruncate(out, n)
					case finalByte == 'J':
						// ED (Erase in Display) — erase from cursor down.
						// After cursor-up, this clears old content below.
						// We handle this implicitly: cursor-up already truncated,
						// and new content will be appended fresh.
					case finalByte == 'K':
						// EL (Erase in Line) — erase from cursor to end of line.
						// Handled implicitly by \r truncation.
					}
					// All other CSI sequences: stripped silently
					i = j + 1
					continue
				}
				// Malformed CSI — skip ESC [
				i += 2
				continue
			}

			if next == ']' {
				// OSC sequence: ESC ] ... (BEL | ESC \)
				j := i + 2
				for j < len(data) {
					if data[j] == 0x07 { // BEL terminates OSC
						j++
						break
					}
					if data[j] == 0x1b && j+1 < len(data) && data[j+1] == '\\' { // ST terminates OSC
						j += 2
						break
					}
					j++
				}
				i = j
				continue
			}

			// Other ESC sequences (e.g., ESC ( B for charset) — skip 2 bytes
			i += 2
			continue
		}

		// Carriage return handling
		if b == '\r' {
			if i+1 < len(data) && data[i+1] == '\n' {
				// \r\n → \n (normal line ending)
				out = append(out, '\n')
				i += 2
			} else {
				// Standalone \r — overwrite current line (truncate back to last \n)
				out = truncateToLineStart(out)
				i++
			}
			continue
		}

		out = append(out, b)
		i++
	}
	return out
}

// truncateToLineStart truncates buf back to the position just after the last \n.
// If no \n exists, truncates to empty.
func truncateToLineStart(buf []byte) []byte {
	for k := len(buf) - 1; k >= 0; k-- {
		if buf[k] == '\n' {
			return buf[:k+1]
		}
	}
	return buf[:0]
}

// cursorUpTruncate removes the current row and (n-1) complete rows above it.
// Used for ESC[nA: cursor moves up n rows, subsequent text overwrites from there.
func cursorUpTruncate(out []byte, n int) []byte {
	// Remove current row content (partial line or empty row after \n)
	if len(out) > 0 && out[len(out)-1] == '\n' {
		// Cursor is on empty row after trailing \n — consume the \n
		out = out[:len(out)-1]
	}
	// Remove remaining content on the current row
	for len(out) > 0 && out[len(out)-1] != '\n' {
		out = out[:len(out)-1]
	}
	// One row removed. Now remove (n-1) more complete lines above.
	for i := 0; i < n-1 && len(out) > 0; i++ {
		if out[len(out)-1] == '\n' {
			out = out[:len(out)-1]
		}
		for len(out) > 0 && out[len(out)-1] != '\n' {
			out = out[:len(out)-1]
		}
	}
	return out
}

// ParseCSIParam is the exported version of parseCSIParam.
func ParseCSIParam(params []byte) int {
	return parseCSIParam(params)
}

// parseCSIParam extracts the first numeric parameter from CSI parameter bytes.
// Returns the parsed integer, or 0 if no valid number found.
// For "12" returns 12, for "1;2" returns 1, for "" returns 0.
func parseCSIParam(params []byte) int {
	n := 0
	for _, b := range params {
		if b >= '0' && b <= '9' {
			n = n*10 + int(b-'0')
		} else {
			break // stop at first non-digit (e.g., ';' or '?')
		}
	}
	return n
}
