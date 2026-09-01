# Obelisk parity baseline

`baseline.json` is the machine-readable, immutable comparison contract for
`tommy0103/obelisk@f256668`. It deliberately separates `delivered`, `specified`,
and `planned`; a README claim is not delivery evidence.

Run the contract checks with:

```bash
npm run lint:baseline
```

The I0 gate remains `in-progress` until a redistributable five-provider corpus,
an isolated-HOME Obelisk runner, and hardware-stamped same-host results are
checked in. Later upstream rescans may add notes or new journeys, but must not
move this pinned revision or an already accepted parity gate.
