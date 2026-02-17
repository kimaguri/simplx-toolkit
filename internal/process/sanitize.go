package process

// sanitizeForLog strips terminal control sequences that don't render well
// in a scrollback log viewer. Keeps SGR (color/style) sequences intact.
//
// Strips: cursor movement, line/screen clearing, OSC (title), other CSI.
// Converts standalone \r (not followed by \n) to \n for readability.
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
					if data[j] == 'm' {
						// SGR (Select Graphic Rendition) — keep colors
						out = append(out, data[i:j+1]...)
					}
					// All other CSI sequences: stripped
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
