# B0 Sandbox Spike Harness

Disposable harness for `docs/adr/B0-sandbox-spike.md`.

This is not production app code and is not a real App Sandbox proof. It copies
the local Node 22 binary when available, plus the two native addon files, into
`stage/`; ad-hoc signs those copies; then runs a smoke script that forces
`better-sqlite3` and `@lancedb/lancedb` to load the signed addon copies.

Run from the repo root:

```sh
./spikes/sandbox-b0/prepare-and-run.sh
```

Override the Node binary explicitly when needed:

```sh
MOZI_B0_NODE=/path/to/node ./spikes/sandbox-b0/prepare-and-run.sh
```

Generated binaries, temp data, and logs stay under ignored paths in this
directory.
