"""Render the current PostgreSQL graph-query measurements."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--no-chart', action='store_true', help='Write the Markdown reports only.')
modes = parser.add_mutually_exclusive_group()
modes.add_argument('--flat-grid', action='store_true', help='Render the flat tuning Markdown report.')
modes.add_argument('--shared-pool', action='store_true', help='Render the shared-pool Markdown report.')
modes.add_argument('--application', action='store_true', help='Render the application report and performance guide.')
args = parser.parse_args()

root = Path(__file__).resolve().parent


def application_summary(path):
    report = json.loads(path.read_text())
    metadata = report['metadata']
    defaults = metadata['flatDefault']
    postgres = ' '.join(metadata['postgres'].split()[:2])
    rows = report['results']
    lookup = {(row['scenario'], row['requests'], row['method']): row for row in rows}
    scenarios = {row['scenario']: row for row in rows}
    lines = [
        f"Recorded {metadata['createdAt']} on {metadata['cpu']} with Node.js {metadata['node']}, "
        f"{postgres}, Kysely {metadata['kysely']}, and pg {metadata['pg']}. "
        f"Pool size {metadata['poolMax']} over {metadata['transport']}.", '',
        f"The benchmark uses synthetic data seeded with {metadata['seedRoots']:,} users and "
        'returns the same ordered, projected results with both strategies.', '',
        '| Workload | Response shape | JSON size | SQL statements (flat / single) |',
        '|---|---|---:|---:|',
    ]

    def value_range(values, render):
        low, high = min(values), max(values)
        return render(low) if low == high else f'{render(low)}–{render(high)}'

    for name, row in scenarios.items():
        requests = row['requests']
        size = value_range(row['outputBytes'], lambda value: f'{value / 1024:.2f}')
        counts = [
            value_range(lookup[(name, requests, method)]['queryCounts'], str)
            for method in ('flat', 'single')
        ]
        lines.append(f"| {name} | {row['description']} | {size} KiB | {' / '.join(counts)} |")
    lines.extend([
        '',
        f"The default `flat` strategy uses raw pg decoding and {defaults['chunkSize']} keys per batch. "
        f"Each strategy shares {defaults['concurrency']} SQL statement slots across requests on its graph instance. "
        'Each `single` request uses one slot for its one statement.', '',
        f"Each case ran {metadata['warmups']} warmup waves and {metadata['samples']} measured waves "
        'on warm, pre-opened connections with PostgreSQL JIT disabled and natural Node.js garbage collection. '
        'Each wave starts all requests together, rotating through eight input pages or post IDs. '
        'Timings include query construction, database work, transfer, decoding, and graph assembly. '
        'Request latency includes queueing. The p95 uses the nearest rank over all request times for a case. '
        'Node CPU is the median process CPU per wave divided by its request count. '
        'PostgreSQL CPU and final JSON serialization are outside the Node CPU measurement.',
        '',
        '| Workload | Overlapping requests | Flat median / p95 | Single median / p95 | Flat Node CPU / request | Single Node CPU / request |',
        '|---|---:|---:|---:|---:|---:|',
    ])
    for flat in (row for row in rows if row['method'] == 'flat'):
        name, requests = flat['scenario'], flat['requests']
        single = lookup[(name, requests, 'single')]
        latencies = [f"{row['medianMs']:.2f} / {row['p95Ms']:.2f} ms" for row in (flat, single)]
        cpu = [f"{row['medianNodeCpuMsPerRequest']:.2f} ms" for row in (flat, single)]
        lines.append(f'| {name} | {requests} | ' + ' | '.join(latencies + cpu) + ' |')
    return lines, rows


application_path = root / 'results/application.json'
app_summary, app_rows = application_summary(application_path) if args.application or (
    not (args.flat_grid or args.shared_pool) and application_path.is_file()
) else ([], [])

if args.application:
    application_report = [
        '# Application-shaped graph workloads', '', *app_summary, '',
        '## Pool use and throughput', '',
        'Throughput measures requests per median wave duration within each burst.', '',
        '| Workload | Strategy | Overlapping requests | Requests / second | Peak connections |',
        '|---|---|---:|---:|---:|',
    ]
    application_report.extend(
        f"| {row['scenario']} | {row['method']} | {row['requests']} | "
        f"{row['requestsPerSecond']:,.0f} | {row['peakConnections']} |"
        for row in app_rows
    )
    application_report.extend(['', 'See the [methodology](../README.md) and [raw waves](application.json).'])
    (root / 'results/APPLICATION.md').write_text('\n'.join(application_report) + '\n')

if args.shared_pool:
    load_report = json.loads((root / 'results/flat-shared-pool.json').read_text())
    metadata = load_report['metadata']
    defaults = metadata['flatDefault']
    postgres = ' '.join(metadata['postgres'].split()[:2])
    lines = [
        '# Flat requests sharing one pool', '',
        f"Recorded {metadata['createdAt']} on {metadata['cpu']} with {postgres}, "
        f"Node.js {metadata['node']}, and a pool of {metadata['poolMax']} over {metadata['transport']}.", '',
        f"One graph instance used the defaults of {defaults['chunkSize']} keys per batch and "
        f"{defaults['concurrency']} query slots shared across requests. Each load level ran "
        f"{metadata['warmups']} warmup waves and {metadata['samples']} measured waves. "
        'A wave starts all requests together. All loads returned identical ordered graphs.', '',
        'Latency percentiles use individual request times across all waves. CPU per request is median '
        'wave Node.js CPU divided by the request count. Throughput uses median wave duration. '
        'CPU excludes PostgreSQL, and timings exclude final JSON serialization.', '',
    ]

    def load_table(rows):
        return [
            '| Roots / depth | Requests per wave | Median latency | p95 latency | Node CPU / request | Requests / second | Peak connections |',
            '|---|---:|---:|---:|---:|---:|---:|',
            *[
                f"| {row['roots']:,} / {row['depth']} | {row['requests']} | "
                f"{row['medianMs']:.1f} ms | {row['p95Ms']:.1f} ms | "
                f"{row['medianNodeCpuMsPerRequest']:.1f} ms | {row['requestsPerSecond']:.1f} | "
                f"{row['peakConnections']} |"
                for row in rows
            ],
        ]

    lines.extend(load_table(load_report['results']))
    lines.extend(['', 'See the [methodology](../README.md) and [raw waves](flat-shared-pool.json).'])
    repeat_path = root / 'results/flat-shared-pool-repeat.json'
    if repeat_path.is_file():
        repeat = json.loads(repeat_path.read_text())
        lines.extend([
            '', '## Repeat of the largest workload', '',
            'A four-request wave in the original run took much longer than the others. The repeat '
            'uses the same setup and measures the largest workload again. The original table '
            'includes every measured wave.', '',
            *load_table(repeat['results']), '',
            'See the [raw repeat waves](flat-shared-pool-repeat.json).',
        ])
    (root / 'results/FLAT-SHARED-POOL.md').write_text('\n'.join(lines) + '\n')
    print('Updated shared-pool report')
    raise SystemExit

if args.flat_grid:
    grid_report = json.loads((root / 'results/flat-tuning.json').read_text())
    metadata = grid_report['metadata']
    baseline = metadata['flatDefault']
    rows = grid_report['results']
    scenarios = list(dict.fromkeys(row['scenario'] for row in rows))
    postgres = ' '.join(metadata['postgres'].split()[:2])
    lines = [
        '# Flat batch size and concurrency', '',
        f"Recorded {metadata['createdAt']} on {metadata['cpu']} with {postgres}, "
        f"Node.js {metadata['node']}, and a pool of {metadata['poolMax']} over {metadata['transport']}.", '',
        f"Each configuration ran with {metadata['warmups']} warmups and {metadata['samples']} "
        'measured rounds. The benchmark uses raw decoding and one graph execution at a time. '
        'Every configuration returned identical ordered results. Node.js CPU excludes PostgreSQL CPU.', '',
        f"Changes are relative to {baseline['chunkSize']} keys and {baseline['concurrency']} concurrent statements.",
    ]
    if metadata['samples'] < 20:
        lines.extend(['', 'At this sample count, nearest-rank p95 is the slowest measured run.'])
    for scenario in scenarios:
        settings = sorted(
            (row for row in rows if row['scenario'] == scenario),
            key=lambda row: (row['chunkSize'], row['concurrency']),
        )
        reference = next(row for row in settings if all(row[key] == value for key, value in baseline.items()))
        lines.extend([
            '', f"## {reference['roots']:,} roots, depth {reference['depth']}", '',
            '| Batch keys | Concurrency | Statements | Median latency | Latency change | Median Node CPU | CPU change | p95 latency |',
            '|---:|---:|---:|---:|---:|---:|---:|---:|',
        ])
        for row in settings:
            lines.append(
                f"| {row['chunkSize']:,} | {row['concurrency']} | {row['queries']} | "
                f"{row['medianMs']:.1f} ms | {row['medianMs'] / reference['medianMs'] - 1:+.1%} | "
                f"{row['medianNodeCpuMs']:.1f} ms | {row['medianNodeCpuMs'] / reference['medianNodeCpuMs'] - 1:+.1%} | "
                f"{row['p95Ms']:.1f} ms |"
            )
    lines.extend(['', 'See the [methodology](../README.md) and [raw samples](flat-tuning.json).'])
    if (root / 'results/flat-tuning-confirmation.json').is_file():
        lines.extend(['', 'The [confirmation run](flat-tuning-confirmation.json) repeated 500/4, 250/4, and 500/8.'])
    (root / 'results/FLAT-TUNING.md').write_text('\n'.join(lines) + '\n')
    print('Updated flat tuning report')
    raise SystemExit

report = json.loads((root / 'results/latest.json').read_text())
metadata = report['metadata']
method_labels = {
    'single': 'Single',
    'flat': 'Flat',
    'sql-correlated': 'Correlated SQL',
    'sql-preaggregated': 'Preaggregated SQL',
    'relations-query': 'Generated single',
    'batched-serial': 'JSON batches (1 slot)',
    'batched-parallel': 'JSON batches (4 slots)',
    'flat-serial': 'Flat batches (1 slot)',
    'flat-parallel': 'Flat batches (4 slots)',
    'hybrid-serial': 'Hybrid (1 slot)',
    'hybrid-parallel': 'Hybrid (4 slots)',
}
methods = [method for method in method_labels if any(row['method'] == method for row in report['results'])]
labels = [method_labels[method] for method in methods]
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

if not (args.no_chart or args.application):
    import matplotlib

    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    positions = range(len(methods))
    for axis in axes.flat:
        axis.set_visible(False)
    for axis, scenario in zip(axes.flat, scenarios):
        axis.set_visible(True)
        chosen = [lookup[(scenario, method)] for method in methods]
        times = [row['medianMs'] for row in chosen]
        axis.barh(positions, times, color=['#334155', '#94a3b8', '#0d9488', '#b45309', '#2563eb', '#a21caf', '#15803d', '#be123c', '#0e7490'])
        axis.set_yticks(positions, labels, fontsize=8)
        axis.invert_yaxis()
        axis.set_xlim(0, max(times) * 1.25)
        axis.set_xlabel('Median end-to-end latency (ms)')
        first = chosen[0]
        axis.set_title(f"{first['roots']:,} roots · depth {first['depth']} · {first['objects']:,} objects")
        for index, value in enumerate(times):
            axis.text(value + max(times) * .02, index, f'{value:.1f}', va='center', fontsize=9)
        axis.spines[['top', 'right']].set_visible(False)

    fig.suptitle('@bitkidd/kysely-graph · relation loading latency', fontsize=15)
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

experimental = any(method.startswith(('batched-', 'hybrid-')) for method in methods)
comparison_note = (
    'This historical comparison includes per-row JSON and hybrid experiments. '
    'Current runs compare the single and flat strategies.'
)
summary = [
    environment, '',
    *([comparison_note, ''] if experimental else []),
    'Both strategies returned identical ordered graphs. The table reports median latency and Node.js CPU time.', '',
    '| Roots / depth | Objects | ' + ' | '.join(
        [f'{label} latency' for label in labels] + [f'{label} Node CPU' for label in labels]
    ) + ' |',
    '|---|' + '---:|' * (2 * len(methods) + 1),
]
for scenario in scenarios:
    first = lookup[(scenario, methods[0])]
    medians = [
        f"{lookup[(scenario, method)][metric]:.1f} ms"
        for metric in ('medianMs', 'medianNodeCpuMs') for method in methods
    ]
    summary.append(f"| {first['roots']:,} / {first['depth']} | {first['objects']:,} | " + ' | '.join(medians) + ' |')

details = [
    '# PostgreSQL graph-query measurements', '', *summary, '',
    '## Query counts', '',
    '| Scenario | ' + ' | '.join(labels) + ' |',
    '|---|' + '---:|' * len(methods),
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
    'See the [methodology](../README.md) and [raw samples](latest.json)'
    + ('.' if args.no_chart else ' and [chart](latency.png).'),
    '', 'Earlier comparisons are available in the [strategy experiment data](strategy-experiments.json).',
]
if not args.application:
    (root / 'results/RESULTS.md').write_text('\n'.join(details) + '\n')

largest_graph = max(row['objects'] for row in rows)
public = [
    '# Performance and benchmarking', '',
    *(['## Application workloads', '', *app_summary, ''] if app_summary else []),
    '## Synthetic stress workloads', '', *summary, '',
    *([] if args.no_chart or args.application else ['![PostgreSQL graph latency comparison](assets/latency.svg)', '']),
    f"The largest graph contains {largest_graph:,} object occurrences. "
    'Fan-out, row width, indexes, pool contention, and network latency affect execution time.', '',
    'Flat uses its defaults of 500 parent keys per batch and four concurrent statements. '
    'Node.js CPU time excludes PostgreSQL CPU.', '',
    f"Each method ran with {metadata['warmups']} warmups and {metadata['samples']} measured rounds "
    'over warm caches and pre-opened connections, with PostgreSQL JIT disabled. '
    'Timings include query construction, database work, transfer, and driver decoding. '
    'Final HTTP JSON serialization is outside the measurement.', '',
    '## Reproduce from a source checkout', '',
    '```sh',
    'nvm use',
    'pnpm install --frozen-lockfile',
    'export DATABASE_URL=postgres://user:password@localhost:5432/database',
    'BENCH_APPLICATION=1 pnpm run bench',
    'python benchmarks/report.py --application',
    'pnpm run bench',
    'python benchmarks/report.py --no-chart',
    '```', '',
    'The database role needs schema creation privileges. Each run creates and removes its own schema. '
    'Set `BENCH_ROOTS`, `BENCH_SAMPLES`, and `BENCH_WARMUPS` to change the workload. '
    'Omit `--no-chart` to regenerate the charts with matplotlib.', '',
    'The source checkout stores application waves in `benchmarks/results/application.json`, '
    'stress samples in `benchmarks/results/latest.json`, and earlier strategy experiments alongside them.', '',
    '[Documentation index](README.md)',
]
(root.parent / 'docs/performance.md').write_text('\n'.join(public) + '\n')
print('Updated benchmark report and package performance guide' +
      ('' if args.no_chart or args.application else ', including charts'))
