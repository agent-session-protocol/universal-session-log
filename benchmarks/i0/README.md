# SESDB I0 parity runners

These runners create a disposable, isolated `HOME`, populate it from the CC0
clean-room corpus, and record hardware-stamped JSON. They never copy Obelisk
source or data into this repository.

```sh
node benchmarks/i0/run-sesdb.mjs
git clone https://github.com/tommy0103/obelisk /tmp/obelisk-i0
git -C /tmp/obelisk-i0 checkout f25666800cda53d78b4304bcd793b6e65a5aad21
node benchmarks/i0/run-obelisk.mjs --checkout /tmp/obelisk-i0
```

Use `--sizes 100,1000,10000` (the default) and `--output <file>`. SESDB reports
SQLite `total_changes` as a portable row-write amplification signal. The
black-box Obelisk runner cannot inspect its connection counters, so it reports
sidecar size-change observations at command boundaries and labels that metric
explicitly. Neither runner treats the 500 ms append-to-query target as a hard
cross-platform gate.

The scale corpus is a deterministic two-record (session + user message) slice
of the Pi clean-room fixture, so the independent variable is session count.
The full five-provider corpus remains the feature/journey input.
