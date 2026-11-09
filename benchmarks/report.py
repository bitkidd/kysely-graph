"""Render the current PostgreSQL graph-query measurements."""
import json
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parent
report = json.loads((root / 'results/latest.json').read_text())
metadata = report['metadata']
methods = ['sql-correlated', 'sql-preaggregated', 'relations-query']
labels = ['SQL: correlated JSON', 'SQL: preaggregated JSON', 'Relations: single query']
rows = [row for row in report['results'] if row['method'] in methods]
scenarios = list(dict.fromkeys(row['scenario'] for row in rows))
lookup = {(row['scenario'], row['method']): row for row in rows}

postgres = ' '.join(metadata['postgres'].split()[:2])
environment = (
    f"Recorded {metadata['createdAt']} on {metadata['cpu']} with Node.js {metadata['node']}, "
    f"{postgres}, Kysely {metadata['kysely']}, and pg {metadata['pg']}. "
    f"Pool size {metadata['poolMax']} over {metadata['transport']}."
)
p95_note = f"p95 uses the nearest rank over {metadata['samples']} samples per method and scenario."
if metadata['samples'] < 20:
    p95_note += ' At this sample count it is the maximum.'

fig, axes = plt.subplots(2, 2, figsize=(13, 9))
positions = range(len(methods))
for axis in axes.flat:
    axis.set_visible(False)
for axis, scenario in zip(axes.flat, scenarios):
    axis.set_visible(True)
    chosen = [lookup[(scenario, method)] for method in methods]
    times = [row['medianMs'] for row in chosen]
    axis.barh(positions, times, color=['#334155', '#94a3b8', '#0d9488'])
    axis.set_yticks(positions, labels, fontsize=8)
    axis.invert_yaxis()
    axis.set_xlim(0, max(times) * 1.25)
    axis.set_xlabel('Median end-to-end latency (ms)')
    first = chosen[0]
    axis.set_title(f"{first['roots']:,} roots · depth {first['depth']} · {first['objects']:,} objects")
    for index, value in enumerate(times):
        axis.text(value + max(times) * .02, index, f'{value:.1f}', va='center', fontsize=9)
    axis.spines[['top', 'right']].set_visible(False)

fig.suptitle('@bitkidd/kysely-graph · generated and handwritten SQL', fontsize=15)
fig.text(
    .5, .01,
    f"{metadata['samples']} warm-cache samples · {metadata['transport']} · root rows included",
    ha='center', fontsize=9,
)
fig.tight_layout(rect=(0, .03, 1, .96))
svg = root / 'results/latency.svg'
fig.savefig(svg)
svg_text = '\n'.join(line.rstrip() for line in svg.read_text().splitlines()) + '\n'
svg.write_text(svg_text)
(root.parent / 'docs/assets/latency.svg').write_text(svg_text)
fig.savefig(root / 'results/latency.png', dpi=160)
plt.close(fig)

summary = [
    environment, '',
    'Each method returned the same graph in one statement, including root rows.', '',
    '| Roots / depth | Objects | Correlated SQL | Preaggregated SQL | Generated query |',
    '|---|---:|---:|---:|---:|',
]
for scenario in scenarios:
    first = lookup[(scenario, methods[0])]
    medians = [f"{lookup[(scenario, method)]['medianMs']:.1f} ms" for method in methods]
    summary.append(f"| {first['roots']:,} / {first['depth']} | {first['objects']:,} | " + ' | '.join(medians) + ' |')

details = [
    '# PostgreSQL graph-query measurements', '', *summary, '',
    '## Query counts', '',
    '| Scenario | Correlated SQL | Preaggregated SQL | Generated query |',
    '|---|---:|---:|---:|',
]
for scenario in scenarios:
    counts = [str(lookup[(scenario, method)]['queries']) for method in methods]
    details.append('| ' + ' | '.join([scenario, *counts]) + ' |')

details += [
    '', '## Detailed measurements', '',
    '| Scenario | Method | Median | p95 | Node CPU | Logical DB result MiB | Output MiB |',
    '|---|---|---:|---:|---:|---:|---:|',
]
for row in rows:
    details.append(
        f"| {row['scenario']} | {row['method']} | {row['medianMs']:.1f} ms | {row['p95Ms']:.1f} ms | "
        f"{row['medianNodeCpuMs']:.1f} ms | {row['logicalResultBytes'] / 2**20:.2f} | "
        f"{row['outputBytes'] / 2**20:.2f} |"
    )

details += [
    '', p95_note, '',
    'Logical database result sizes estimate serialized JSON bytes. Node CPU excludes PostgreSQL CPU.', '',
    'See the [methodology](../README.md), [raw samples](latest.json), '
    '[SQL plans](plans.json), and [chart](latency.png).',
]
(root / 'results/RESULTS.md').write_text('\n'.join(details) + '\n')

largest_graph = max(row['objects'] for row in rows)
public = [
    '# Performance and benchmarking', '', *summary, '',
    '![Generated PostgreSQL query comparison](assets/latency.svg)', '',
    f"The largest graph contains {largest_graph:,} object occurrences. "
    'Fan-out, row width, indexes, pool contention, and network latency affect execution time.', '',
    f"Each method ran with {metadata['warmups']} warmups and {metadata['samples']} measured rounds "
    'over warm caches and pre-opened connections, with PostgreSQL JIT disabled. '
    'Timings include query construction, database work, transfer, and driver decoding. '
    'Final HTTP JSON serialization is outside the measurement.', '',
    '## Reproduce from a source checkout', '',
    '```sh',
    'nvm use',
    'pnpm install --frozen-lockfile',
    'DATABASE_URL=postgres://user:password@localhost:5432/database pnpm run bench',
    'python benchmarks/report.py',
    '```', '',
    'The database role needs schema creation privileges. Each run creates and removes its own schema. '
    'Set `BENCH_ROOTS`, `BENCH_SAMPLES`, and `BENCH_WARMUPS` to change the workload. '
    'The report renderer requires matplotlib.', '',
    'The source checkout stores raw samples in `benchmarks/results/latest.json`, '
    'handwritten SQL plans in `benchmarks/results/plans.json`, and historical runs alongside them.', '',
    '[Documentation index](README.md)',
]
(root.parent / 'docs/performance.md').write_text('\n'.join(public) + '\n')
print('Updated benchmark report, package performance guide, and charts')
