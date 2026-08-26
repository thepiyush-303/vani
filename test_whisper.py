import struct
import sys

# Write 16kHz sine wave 1 second
import math
samples = [int(math.sin(i * 0.1) * 10000) for i in range(16000)]
pcm = struct.pack('<' + 'h'*16000, *samples)

with open('dummy.pcm', 'wb') as f:
    f.write(struct.pack('<I', len(pcm)))
    f.write(pcm)
    f.write(struct.pack('<I', 0))
