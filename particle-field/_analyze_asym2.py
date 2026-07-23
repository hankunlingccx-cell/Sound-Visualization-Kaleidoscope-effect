import struct, zlib, math

path = r"C:\Users\Administrator\.cursor\projects\d-vibecoding-advx-visual-Sound-Visualization-Kaleidoscope-effect\assets\c__Users_Administrator_AppData_Roaming_Cursor_User_workspaceStorage_bda19fd0b1629ba2d51cd0acddc1aaa6_images_image-7417c5bf-9f39-49a6-bbc1-124625fb2148.png"


def read_png(path):
    with open(path, "rb") as f:
        data = f.read()
    i = 8
    w = h = None
    raw = b""
    ctype = None
    while i < len(data):
        ln = struct.unpack(">I", data[i : i + 4])[0]
        i += 4
        typ = data[i : i + 4]
        i += 4
        chunk = data[i : i + ln]
        i += ln + 4
        if typ == b"IHDR":
            w, h = struct.unpack(">II", chunk[:8])
            ctype = chunk[9]
        elif typ == b"IDAT":
            raw += chunk
        elif typ == b"IEND":
            break
    decompressed = zlib.decompress(raw)
    bpp = 3 if ctype == 2 else 4
    stride = w * bpp
    rows = []
    prev = bytearray(stride)
    o = 0
    for y in range(h):
        ft = decompressed[o]
        o += 1
        row = bytearray(decompressed[o : o + stride])
        o += stride
        if ft == 1:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + left) & 255
        elif ft == 2:
            for x in range(stride):
                row[x] = (row[x] + prev[x]) & 255
        elif ft == 3:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + ((left + prev[x]) // 2)) & 255
        elif ft == 4:
            for x in range(stride):
                a = row[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                row[x] = (row[x] + pr) & 255
        rows.append(row)
        prev = row
    return w, h, bpp, rows


w, h, bpp, rows = read_png(path)
# Use geometric center of upper canvas area (exclude dock ~bottom 12%)
cx, cy = w * 0.5, h * 0.48
print("geo center", cx, cy)
N = 72
bins = [0.0] * N
counts = [0] * N
for y in range(int(h * 0.88)):
    row = rows[y]
    for x in range(w):
        j = x * bpp
        lum = row[j] + row[j + 1] + row[j + 2]
        if lum < 35:
            continue
        ang = math.atan2(-(y - cy), x - cx)
        if ang < 0:
            ang += 2 * math.pi
        i = int(ang / (2 * math.pi) * N) % N
        bins[i] += lum
        counts[i] += 1

# Fold to 60-degree sectors to test 6-fold
fold = [0.0] * (N // 6)
for i, v in enumerate(bins):
    fold[i % (N // 6)] += v
print("\n6-fold residual (should be flat if symmetric):")
mx = max(fold) or 1
for i, v in enumerate(fold):
    deg = i * 360 / N
    print(f"  offset {deg:5.1f}: {v/mx:5.2f} {'#'*int(30*v/mx)}")

print("\nPer 10-deg around circle:")
mx = max(bins) or 1
for i in range(0, N, 2):
    v = bins[i] + bins[i + 1]
    deg = i * 360 / N
    print(f"{deg:6.1f} {(v/mx):5.2f} {'#'*int(40*v/mx)}")

# Compare opposite sectors
print("\nSector totals (60 deg):")
for s in range(6):
    total = sum(bins[s * (N // 6) : (s + 1) * (N // 6)])
    print(f"  sector {s} ({s*60}-{(s+1)*60}): {total:.0f}")
