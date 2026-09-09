#!/bin/bash
# demxane-stats.sh
# Sammelt die Auslastung des Mac Mini und schickt sie an demxane.com (/api/push).
# Läuft jede Minute über den LaunchAgent com.demxane.stats (siehe com.demxane.stats.plist).
# Einstellungen in stats.env neben diesem Skript: PUSH_TOKEN=..., optional PUSH_URL=...

set -u
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/stats.env" ]; then
  # shellcheck disable=SC1091
  source "$DIR/stats.env"
fi
PUSH_URL="${PUSH_URL:-https://demxane.com/api/push}"
if [ -z "${PUSH_TOKEN:-}" ]; then
  echo "$(date '+%F %T') PUSH_TOKEN fehlt in $DIR/stats.env" >&2
  exit 1
fi

# --- Rohdaten einsammeln ---------------------------------------------------
CPU_LINE=$(top -l 2 -n 0 -s 1 2>/dev/null | grep 'CPU usage' | tail -1)
VMSTAT=$(vm_stat 2>/dev/null)
SWAP_LINE=$(sysctl -n vm.swapusage 2>/dev/null)
MEMSIZE=$(sysctl -n hw.memsize 2>/dev/null)
BOOT_SEC=$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/^\{ sec = ([0-9]+).*/\1/')
LOAD_LINE=$(sysctl -n vm.loadavg 2>/dev/null)
PRESSURE_LINE=$(memory_pressure 2>/dev/null | tail -1)
PLEX_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:32400/identity 2>/dev/null || echo 000)

# Platten: eine Zeile pro Volume "id|label|gesamt_kb|belegt_kb" (fehlende Volumes: "id|label|-|-")
DISKS=""
while IFS='|' read -r id label mount; do
  line=$(df -k "$mount" 2>/dev/null | tail -1)
  if [ -n "$line" ]; then
    total=$(echo "$line" | awk '{print $2}')
    used=$(echo "$line" | awk '{print $3}')
    DISKS+="$id|$label|$total|$used"$'\n'
  else
    DISKS+="$id|$label|-|-"$'\n'
  fi
done <<'LIST'
system|System|/
movies|Filme|/Volumes/Media Server
tv|Serien|/Volumes/Media Server 2
photos|Fotos|/Volumes/PrivateCloud
audio|Audio|/Volumes/MS Audio
LIST

DOCKER_PS=$(docker ps -a --format '{{.Names}}|{{.State}}' 2>/dev/null)
DOCKER_STATS=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null)

# --- JSON bauen ------------------------------------------------------------
JSON=$(CPU_LINE="$CPU_LINE" VMSTAT="$VMSTAT" SWAP_LINE="$SWAP_LINE" MEMSIZE="$MEMSIZE" BOOT_SEC="$BOOT_SEC" \
  LOAD_LINE="$LOAD_LINE" PRESSURE_LINE="$PRESSURE_LINE" PLEX_CODE="$PLEX_CODE" DISKS="$DISKS" \
  DOCKER_PS="$DOCKER_PS" DOCKER_STATS="$DOCKER_STATS" python3 - <<'PY'
import json, os, re, time

def num(pattern, text, default=None, cast=float):
    m = re.search(pattern, text)
    return cast(m.group(1)) if m else default

env = os.environ
page = 16384

cpu_line = env.get("CPU_LINE", "")
cpu = {
    "user": num(r"([\d.]+)% user", cpu_line, 0.0),
    "sys": num(r"([\d.]+)% sys", cpu_line, 0.0),
    "idle": num(r"([\d.]+)% idle", cpu_line, 100.0),
}

vm = env.get("VMSTAT", "")
def pages(label):
    return num(rf"{label}:\s+(\d+)", vm, 0, int) * page
mem = {
    "totalBytes": int(env.get("MEMSIZE") or 0),
    "freeBytes": pages("Pages free"),
    "activeBytes": pages("Pages active"),
    "inactiveBytes": pages("Pages inactive"),
    "wiredBytes": pages("Pages wired down"),
    "compressedBytes": pages("Pages occupied by compressor"),
    "freePct": num(r"(\d+)%", env.get("PRESSURE_LINE", ""), None, int),
}

def mb(pattern, text):
    v = num(pattern, text, 0.0)
    return int(v * 1024 * 1024)
swap_line = env.get("SWAP_LINE", "")
swap = {"totalBytes": mb(r"total = ([\d.]+)M", swap_line), "usedBytes": mb(r"used = ([\d.]+)M", swap_line)}

load = [float(x) for x in re.findall(r"[\d.]+", env.get("LOAD_LINE", ""))[:3]]

boot = int(env.get("BOOT_SEC") or 0)
uptime = int(time.time()) - boot if boot else None

disks = []
for line in env.get("DISKS", "").splitlines():
    parts = line.split("|")
    if len(parts) != 4:
        continue
    did, label, total, used = parts
    if total == "-":
        disks.append({"id": did, "label": label, "missing": True})
    else:
        disks.append({"id": did, "label": label, "totalBytes": int(total) * 1024, "usedBytes": int(used) * 1024})

containers = [l.split("|") for l in env.get("DOCKER_PS", "").splitlines() if "|" in l]
running = sum(1 for c in containers if c[1] == "running")

def to_mib(s):
    s = s.strip()
    m = re.match(r"([\d.]+)\s*([KMG]i?B)", s)
    if not m:
        return 0.0
    v, unit = float(m.group(1)), m.group(2)
    return v / 1024 if unit.startswith("K") else v * 1024 if unit.startswith("G") else v
stats = []
for l in env.get("DOCKER_STATS", "").splitlines():
    p = l.split("|")
    if len(p) != 3:
        continue
    stats.append({"name": p[0], "cpu": num(r"([\d.]+)%", p[1], 0.0), "memMiB": round(to_mib(p[2].split("/")[0]), 1)})
stats.sort(key=lambda s: s["cpu"], reverse=True)

payload = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "uptimeSec": uptime,
    "cpu": cpu,
    "load": load,
    "mem": mem,
    "swap": swap,
    "disks": disks,
    "docker": {"running": running, "total": len(containers), "top": stats[:5]},
    "plexLocal": env.get("PLEX_CODE") == "200",
}
print(json.dumps(payload, separators=(",", ":")))
PY
)

if [ -z "$JSON" ]; then
  echo "$(date '+%F %T') JSON leer, nichts gesendet" >&2
  exit 1
fi

# Zum Testen: DRY_RUN=1 ./demxane-stats.sh zeigt nur das JSON und sendet nichts.
if [ -n "${DRY_RUN:-}" ]; then
  echo "$JSON"
  exit 0
fi

# --- Senden ------------------------------------------------------------------
CODE=$(curl -s -o /tmp/demxane-stats-response.txt -w '%{http_code}' --max-time 25 \
  -X POST "$PUSH_URL" \
  -H "Authorization: Bearer $PUSH_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$JSON")

if [ "$CODE" = "200" ]; then
  echo "$(date '+%F %T') ok $(cat /tmp/demxane-stats-response.txt)"
else
  echo "$(date '+%F %T') Fehler HTTP $CODE $(head -c 200 /tmp/demxane-stats-response.txt)" >&2
  exit 1
fi
