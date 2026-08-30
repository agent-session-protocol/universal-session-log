import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-col items-center justify-center text-center flex-1 px-6 py-16 gap-8 max-w-4xl mx-auto">
      <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
        USL — Universal Session Log
      </h1>
      <p className="text-xl text-fd-muted-foreground leading-relaxed">
        The <span className="font-medium text-fd-foreground">agent-session database</span>.
        <br />
        A complete storage layer for agent runtimes — on-disk format, query API,
        durability & recovery, live capture, and cross-harness conversion.
      </p>

      <div className="flex flex-row gap-4">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
        >
          Read the docs
        </Link>
        <Link
          href="/docs/getting-started"
          className="rounded-lg border border-fd-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
        >
          Getting started
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 w-full mt-4">
        {[
          ['Storage format', 'Append-only single file: framed records with length + CRC. Recovery truncates at the first torn frame, byte-deterministically.'],
          ['Query API', 'scan / get / verify / fromSeq over content-addressed sessions. Snapshots and event streams, not SQL.'],
          ['Durability', 'Group-commit append + full-fsync flush. Crash recovery rebuilds the index from the log — header optional.'],
          ['Live capture', 'File-boundary ingestion with line framing that is invariant to write chunking.'],
          ['Conversion', 'pi / dimagent / claude / codex inter-conversion with declared per-axis fidelity.'],
          ['Schema-agnostic', 'Stores opaque records; the ASP canonical schema is a layer above, not the engine.'],
        ].map(([title, body]) => (
          <div key={title} className="rounded-lg border border-fd-border p-5 text-left">
            <h2 className="text-sm font-semibold mb-2">{title}</h2>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
