"""CPU simulation of polarLocal angular coverage across kaleidoscope copies."""
import math

TAU = math.tau
sector_count = 6
sector_angle = TAU / sector_count
sector_half = sector_angle * 0.5

# Simplified th from current polarLocal extremes
def sample_th(u, curve_id, rnd, phase, topology_mix=0.48, fold=0.58, ang_flow=0.16, mid=0.3):
    # topology A
    seed_a = ((math.fmod(curve_id * 0.371 + rnd * 0.23, 1.0)) - 0.5) * 0.85
    th_a = seed_a + (0.95 if True else 0.35) * (u - 0.5)
    th_a += (0.28 + fold * 0.42) * math.sin(u * TAU * 1.5 + phase)
    # topology B
    seed_b = ((math.fmod(curve_id * 0.613 + rnd * 0.41, 1.0)) - 0.5) * 1.1
    th_b = seed_b + 0.55 * (u - 0.5)
    th_b += (0.22 + fold * 0.35) * math.sin(u * TAU * 1.6 + phase)
    th = th_a * (1 - topology_mix) + th_b * topology_mix
    audio_w = 0.32
    th += audio_w * mid * (0.18 + fold * 0.22) * math.sin(u * TAU * 1.8 + phase)
    th += audio_w * ang_flow * 0.35 * mid
    th = max(-1.35, min(1.35, th))
    return th

N = 72
bins = [0.0] * N
curves = [(0.17, 0.3, 0.1), (1.17, 0.6, 0.5), (2.17, 0.2, 1.2), (3.17, 0.8, 2.0), (4.17, 0.4, 0.7), (5.17, 0.9, 1.5)]
for cid, rnd, phase in curves:
    for i in range(64):
        u = i / 63
        th = sample_th(u, cid, rnd, phase)
        for rot in range(sector_count):
            for mirror in (1.0, -1.0):
                theta = rot * sector_angle + mirror * (th * sector_half)
                ang = theta % TAU
                if ang < 0:
                    ang += TAU
                bins[int(ang / TAU * N) % N] += 1

print("Simulated coverage (should be ~6-fold):")
mx = max(bins) or 1
for s in range(6):
    total = sum(bins[s * (N // 6) : (s + 1) * (N // 6)])
    print(f"  sector {s}: {total}")
print("fold residual:")
fold = [0.0] * (N // 6)
for i, v in enumerate(bins):
    fold[i % (N // 6)] += v
for i, v in enumerate(fold):
    print(f"  {i*5:2d} deg: {v/max(fold):.3f}")

# Check if th distribution is biased
ths = [sample_th(i/63, c[0], c[1], c[2]) for c in curves for i in range(64)]
print(f"th mean={sum(ths)/len(ths):.3f} min={min(ths):.3f} max={max(ths):.3f}")
print(f"frac th>0: {sum(1 for t in ths if t>0)/len(ths):.3f}")
