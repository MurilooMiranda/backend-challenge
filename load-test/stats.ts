export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? total / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!match) {
      continue;
    }
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
      labels[pair[1]!] = pair[2]!;
    }
    samples.push({ name: match[1]!, labels, value: Number(match[3]) });
  }
  return samples;
}

export function sumMetric(
  samples: Sample[],
  name: string,
  filter: Record<string, string> = {},
): number {
  return samples
    .filter(
      (sample) =>
        sample.name === name &&
        Object.entries(filter).every(([key, value]) => sample.labels[key] === value),
    )
    .reduce((sum, sample) => sum + sample.value, 0);
}

export function histogramQuantile(
  samples: Sample[],
  name: string,
  quantile: number,
  filter: Record<string, string> = {},
): number {
  const buckets = new Map<number, number>();
  for (const sample of samples) {
    if (sample.name !== `${name}_bucket`) {
      continue;
    }
    if (!Object.entries(filter).every(([key, value]) => sample.labels[key] === value)) {
      continue;
    }
    const le = sample.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(sample.labels.le);
    buckets.set(le, (buckets.get(le) ?? 0) + sample.value);
  }
  const ordered = [...buckets.entries()].sort(([a], [b]) => a - b);
  const total = ordered.at(-1)?.[1] ?? 0;
  if (total === 0) {
    return 0;
  }
  const target = quantile * total;
  let previousBound = 0;
  let previousCount = 0;
  for (const [bound, count] of ordered) {
    if (count >= target) {
      if (!Number.isFinite(bound)) {
        return previousBound;
      }
      const inBucket = count - previousCount;
      const fraction = inBucket === 0 ? 1 : (target - previousCount) / inBucket;
      return previousBound + (bound - previousBound) * fraction;
    }
    previousBound = bound;
    previousCount = count;
  }
  return previousBound;
}
