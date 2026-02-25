package process

import "bytes"

// sanitizeForLog strips terminal control sequences that don't render well
// in a scrollback log viewer. Keeps SGR (color/style) sequences intact.
//
// Special handling:
//   - CSI <n> C (Cursor Forward / CUF) → replaced with n spaces.
//     Claude Code and other Ink-based TUIs use CUF instead of literal
//     space characters for visual spacing between words.
//   - SGR sequences (final byte 'm') are preserved for colors.
//   - All other CSI sequences are stripped.
//   - OSC sequences (ESC ] ... BEL/ST) are stripped.
//   - Standalone \r → \n, \r\n → \n.
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
						// ESC [ <n> C moves cursor right by n (default 1).
						n := parseCSIParam(data[i+2 : j])
						if n <= 0 {
							n = 1
						}
						out = append(out, bytes.Repeat([]byte{' '}, n)...)
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
				// Standalone \r (line overwrite) → \n for log readability
				out = append(out, '\n')
				i++
			}
			continue
		}

		out = append(out, b)
		i++
	}
	return out
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
