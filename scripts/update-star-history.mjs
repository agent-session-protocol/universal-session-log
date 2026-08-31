import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const outputPath = resolve(process.argv[2] || "docs/star-history.svg");

if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be set to owner/repository");
}

if (!token) {
  throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
}

const headers = {
  Accept: "application/vnd.github.star+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "universal-session-log-star-history",
};

async function fetchStarDates() {
  const dates = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/stargazers`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`GitHub API returned ${response.status}: ${details}`);
    }

    const stars = await response.json();
    dates.push(...stars.map(({ starred_at: starredAt }) => new Date(starredAt)));
    if (stars.length < 100) break;
  }

  return dates.sort((left, right) => left - right);
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(timestamp);
}

function formatTick(timestamp, includeTime) {
  if (!includeTime) return formatDate(timestamp);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(timestamp);
}

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

function niceMaximum(value) {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function renderSvg(starDates) {
  const width = 900;
  const height = 520;
  const plot = { left: 76, right: 864, top: 92, bottom: 444 };
  const now = Date.now();
  const firstStar = starDates.length ? starDates[0].getTime() : now;
  const lastStar = starDates.length ? starDates.at(-1).getTime() : now;
  const range = Math.max(lastStar - firstStar, 3_600_000);
  const padding = Math.max(range * 0.04, 1_800_000);
  const startTime = firstStar - padding;
  const endTime = lastStar + padding;
  const maximum = niceMaximum(starDates.length);
  const x = (timestamp) => plot.left
    + ((timestamp - startTime) / (endTime - startTime)) * (plot.right - plot.left);
  const y = (count) => plot.bottom
    - (count / maximum) * (plot.bottom - plot.top);

  const points = [[startTime, 0]];
  starDates.forEach((date, index) => points.push([date.getTime(), index + 1]));
  points.push([endTime, starDates.length]);

  const line = points.map(([day, value], index) => `${index ? "L" : "M"}${x(day).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(endTime).toFixed(1)},${plot.bottom} L${x(startTime).toFixed(1)},${plot.bottom} Z`;

  const yTicks = Array.from({ length: 6 }, (_, index) => {
    const value = (maximum / 5) * index;
    const tickY = y(value);
    return `<line class="grid" x1="${plot.left}" y1="${tickY}" x2="${plot.right}" y2="${tickY}"/><text class="axis" x="${plot.left - 14}" y="${tickY + 5}" text-anchor="end">${Math.round(value)}</text>`;
  }).join("\n    ");

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const timestamp = startTime + ((endTime - startTime) / 4) * index;
    const includeTime = endTime - startTime < 3 * 86_400_000;
    const anchor = index === 0 ? "start" : index === 4 ? "end" : "middle";
    return `<text class="axis" x="${x(timestamp)}" y="${plot.bottom + 34}" text-anchor="${anchor}">${escapeXml(formatTick(timestamp, includeTime))}</text>`;
  }).join("\n    ");

  const title = escapeXml(repository);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Star history for ${title}</title>
  <desc id="description">${starDates.length} GitHub stars from ${formatDate(firstStar)} through ${formatDate(lastStar)}</desc>
  <style>
    .background { fill: #ffffff; }
    .title { fill: #1f2328; font: 600 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .total { fill: #656d76; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .axis { fill: #656d76; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .grid { stroke: #d8dee4; stroke-width: 1; }
    .area { fill: #2f81f7; opacity: 0.14; }
    .line { fill: none; stroke: #2f81f7; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .point { fill: #2f81f7; stroke: #ffffff; stroke-width: 3; }
    @media (prefers-color-scheme: dark) {
      .background { fill: #0d1117; }
      .title { fill: #e6edf3; }
      .total, .axis { fill: #8d96a0; }
      .grid { stroke: #30363d; }
      .area { fill: #4493f8; opacity: 0.18; }
      .line { stroke: #4493f8; }
      .point { fill: #4493f8; stroke: #0d1117; }
    }
  </style>
  <rect class="background" width="${width}" height="${height}" rx="8"/>
  <text class="title" x="${plot.left}" y="46">Star History</text>
  <text class="total" x="${plot.left}" y="70">${title} · ${starDates.length} stars</text>
  <g>
    ${yTicks}
    ${xTicks}
    <path class="area" d="${area}"/>
    <path class="line" d="${line}"/>
    <circle class="point" cx="${x(lastStar)}" cy="${y(starDates.length)}" r="5"/>
  </g>
</svg>
`;
}

const starDates = await fetchStarDates();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderSvg(starDates));
console.log(`Wrote ${outputPath} with ${starDates.length} stars`);
