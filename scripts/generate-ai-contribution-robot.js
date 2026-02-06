#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

const LIGHT_THEME = {
  name: "light",
  background: "#f8fafc",
  panel: "#ffffff",
  border: "#e2e8f0",
  gridBase: "#edf2f7",
  muted: "#64748b",
  text: "#0f172a",
  low: "#86efac",
  medium: "#22c55e",
  high: "#16a34a",
  accent: "#0284c7",
  accentStrong: "#0ea5e9",
  robotBody: "#e2e8f0",
  robotStroke: "#334155",
  robotEye: "#0ea5e9",
  beam: "rgba(14, 165, 233, 0.28)",
};

const DARK_THEME = {
  name: "dark",
  background: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  gridBase: "#21262d",
  muted: "#8b949e",
  text: "#c9d1d9",
  low: "#0e4429",
  medium: "#26a641",
  high: "#39d353",
  accent: "#58a6ff",
  accentStrong: "#79c0ff",
  robotBody: "#7ee787",
  robotStroke: "#0d1117",
  robotEye: "#0d1117",
  beam: "rgba(88, 166, 255, 0.35)",
};

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const username = process.env.PROFILE_USERNAME || process.env.GITHUB_ACTOR;
  const outputDir = process.env.OUTPUT_DIR || "dist";

  if (!username) {
    throw new Error("Missing PROFILE_USERNAME or GITHUB_ACTOR.");
  }

  const calendar = await fetchContributionCalendar({ token, username });
  const weeks = calendar.weeks || [];
  const days = weeks.flatMap((week, weekIndex) =>
    week.contributionDays.map((day) => ({ ...day, weekIndex })),
  );

  if (days.length === 0) {
    throw new Error(`No contribution data available for "${username}".`);
  }

  const metrics = getGridMetrics(weeks.length);
  const lightSvg = createRobotSvg({ username, days, metrics, theme: LIGHT_THEME });
  const darkSvg = createRobotSvg({ username, days, metrics, theme: DARK_THEME });

  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outputDir, "github-contribution-grid-robot.svg"), lightSvg, "utf8"),
    fs.writeFile(path.join(outputDir, "github-contribution-grid-robot-dark.svg"), darkSvg, "utf8"),
  ]);
}

async function fetchContributionCalendar({ token, username }) {
  const attempts = [];

  if (token) {
    try {
      return await fetchContributionCalendarGraphQL({ token, username });
    } catch (error) {
      attempts.push(`GraphQL: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    attempts.push("GraphQL: skipped (missing GITHUB_TOKEN)");
  }

  try {
    return await fetchContributionCalendarFromPublicCalendar({ username });
  } catch (error) {
    attempts.push(`Public calendar: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error(`Unable to fetch contribution data for "${username}". ${attempts.join(" | ")}`);
}

async function fetchContributionCalendarGraphQL({ token, username }) {
  const query = `
    query($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                date
                weekday
              }
            }
          }
        }
      }
    }
  `;

  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-contribution-robot-generator",
    },
    body: JSON.stringify({
      query,
      variables: {
        username,
        from: oneYearAgo.toISOString(),
        to: now.toISOString(),
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GraphQL request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message).join("; ");
    throw new Error(`GitHub GraphQL errors: ${message}`);
  }

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new Error(`Contribution calendar not found for "${username}".`);
  }

  return calendar;
}

async function fetchContributionCalendarFromPublicCalendar({ username }) {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);

  const url = new URL(`https://github.com/users/${encodeURIComponent(username)}/contributions`);
  url.searchParams.set("from", formatDateForQuery(oneYearAgo));
  url.searchParams.set("to", formatDateForQuery(now));

  const response = await fetch(url, {
    headers: {
      "User-Agent": "ai-contribution-robot-generator",
      Accept: "image/svg+xml,text/html;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Contribution calendar request failed (${response.status})`);
  }

  const body = await response.text();
  const rectPattern = /<rect\b[^>]*class="[^"]*ContributionCalendar-day[^"]*"[^>]*>/g;
  const rectNodes = body.match(rectPattern) || [];
  const parsedDays = [];

  for (const rectNode of rectNodes) {
    const dateMatch = rectNode.match(/\bdata-date="([^"]+)"/);
    const countMatch = rectNode.match(/\bdata-count="(\d+)"/);
    if (!dateMatch || !countMatch) {
      continue;
    }

    const date = dateMatch[1];
    const contributionCount = Number.parseInt(countMatch[1], 10);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

    if (!Number.isFinite(contributionCount)) {
      continue;
    }

    parsedDays.push({
      date,
      weekday,
      contributionCount,
    });
  }

  if (parsedDays.length === 0) {
    throw new Error("No contribution-day nodes found in public calendar response");
  }

  parsedDays.sort((left, right) => left.date.localeCompare(right.date));
  const weeks = groupDaysIntoWeeks(parsedDays);
  if (weeks.length === 0) {
    throw new Error("Failed to group public contribution calendar into weeks");
  }

  return { weeks };
}

function getGridMetrics(weekCount) {
  const cell = 11;
  const gap = 4;
  const offsetX = 68;
  const offsetY = 58;
  const graphWidth = weekCount * (cell + gap) - gap;
  const graphHeight = 7 * (cell + gap) - gap;

  return {
    cell,
    gap,
    offsetX,
    offsetY,
    graphWidth,
    graphHeight,
    width: offsetX + graphWidth + 30,
    height: offsetY + graphHeight + 92,
    centerX: offsetX + graphWidth / 2,
  };
}

function createRobotSvg({ username, days, metrics, theme }) {
  const maxCount = Math.max(...days.map((day) => day.contributionCount), 1);
  const activeDays = days.filter((day) => day.contributionCount > 0);
  const motionDays = activeDays.length > 0 ? activeDays : [days[days.length - 1]];

  const pathPoints = motionDays.map((day) => getCellCenter(day, metrics));
  const scanPath = buildPath(pathPoints);
  const motionDuration = Math.max(14, Math.min(38, motionDays.length / 2.2)).toFixed(2);
  const monthLabels = buildMonthLabels(days, metrics);

  const baseCells = days
    .map((day) => {
      const { x, y } = getCellTopLeft(day, metrics);
      return `<rect x="${x}" y="${y}" width="${metrics.cell}" height="${metrics.cell}" rx="2" ry="2" fill="${theme.gridBase}" stroke="${theme.border}" stroke-width="0.25" />`;
    })
    .join("");

  const contributionCells = days
    .filter((day) => day.contributionCount > 0)
    .map((day, index) => {
      const { x, y } = getCellTopLeft(day, metrics);
      const cellColor = getContributionColor(day.contributionCount, maxCount, theme);
      const delay = (index * 0.11).toFixed(2);
      return [
        `<rect x="${x}" y="${y}" width="${metrics.cell}" height="${metrics.cell}" rx="2" ry="2" fill="${cellColor}">`,
        `<title>${formatDate(day.date)} · ${day.contributionCount} contribution${day.contributionCount > 1 ? "s" : ""}</title>`,
        `<animate attributeName="opacity" values="0.82;1;0.82" dur="3.2s" begin="${delay}s" repeatCount="indefinite" />`,
        "</rect>",
      ].join("");
    })
    .join("");

  const monthLabelsMarkup = monthLabels
    .map((label) => `<text x="${label.x}" y="${metrics.offsetY - 10}" fill="${theme.muted}" font-size="10" font-family="Inter, Segoe UI, Arial, sans-serif">${label.text}</text>`)
    .join("");

  const weekLabelsMarkup = [
    { text: "Mon", day: 1 },
    { text: "Wed", day: 3 },
    { text: "Fri", day: 5 },
  ]
    .map((item) => {
      const y = metrics.offsetY + item.day * (metrics.cell + metrics.gap) + 8;
      return `<text x="${metrics.offsetX - 36}" y="${y}" fill="${theme.muted}" font-size="10" font-family="Inter, Segoe UI, Arial, sans-serif">${item.text}</text>`;
    })
    .join("");

  return [
    `<svg width="${metrics.width}" height="${metrics.height}" viewBox="0 0 ${metrics.width} ${metrics.height}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img" aria-labelledby="title desc">`,
    `<title id="title">AI Contribution Robot for ${username}</title>`,
    `<desc id="desc">Animated robot that scans your GitHub contribution graph.</desc>`,
    `<defs>`,
    `<filter id="robotGlow" x="-100%" y="-100%" width="300%" height="300%">`,
    `<feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="${theme.accentStrong}" flood-opacity="0.45" />`,
    `</filter>`,
    `<linearGradient id="headerGlow-${theme.name}" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0%" stop-color="${theme.accentStrong}" stop-opacity="0.15" />`,
    `<stop offset="100%" stop-color="${theme.accentStrong}" stop-opacity="0" />`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="${metrics.width}" height="${metrics.height}" rx="18" ry="18" fill="${theme.background}" />`,
    `<rect x="10" y="10" width="${metrics.width - 20}" height="${metrics.height - 20}" rx="14" ry="14" fill="${theme.panel}" stroke="${theme.border}" stroke-width="1" />`,
    `<rect x="10" y="10" width="${metrics.width - 20}" height="42" rx="14" ry="14" fill="url(#headerGlow-${theme.name})" />`,
    `<text x="26" y="36" fill="${theme.text}" font-size="16" font-weight="600" font-family="Inter, Segoe UI, Arial, sans-serif">🤖 AI Contribution Robot</text>`,
    `<text x="${metrics.width - 24}" y="36" text-anchor="end" fill="${theme.muted}" font-size="11" font-family="Inter, Segoe UI, Arial, sans-serif">@${username}</text>`,
    `<path id="scanPath" d="${scanPath}" fill="none" stroke="${theme.accent}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.38" stroke-dasharray="5 8">`,
    `<animate attributeName="stroke-dashoffset" from="0" to="-26" dur="2.2s" repeatCount="indefinite" />`,
    `</path>`,
    baseCells,
    contributionCells,
    monthLabelsMarkup,
    weekLabelsMarkup,
    `<g filter="url(#robotGlow)">`,
    `<g>`,
    `<path d="M -12 4 L 0 -12 L 12 4 Z" fill="${theme.beam}">`,
    `<animate attributeName="opacity" values="0.2;0.6;0.2" dur="1.4s" repeatCount="indefinite" />`,
    `</path>`,
    `<g transform="translate(-12,-12)">`,
    `<rect x="-2" y="-8" width="4" height="5" rx="1" fill="${theme.robotStroke}" />`,
    `<circle cx="0" cy="-8" r="2.1" fill="${theme.accentStrong}">`,
    `<animate attributeName="r" values="1.6;2.3;1.6" dur="1.4s" repeatCount="indefinite" />`,
    `</circle>`,
    `<rect x="-10" y="-3" width="20" height="16" rx="4" fill="${theme.robotBody}" stroke="${theme.robotStroke}" stroke-width="1.8" />`,
    `<rect x="-13" y="0" width="3" height="8" rx="1.5" fill="${theme.robotStroke}" />`,
    `<rect x="10" y="0" width="3" height="8" rx="1.5" fill="${theme.robotStroke}" />`,
    `<rect x="-6.5" y="13" width="4" height="4" rx="1" fill="${theme.robotStroke}" />`,
    `<rect x="2.5" y="13" width="4" height="4" rx="1" fill="${theme.robotStroke}" />`,
    `<rect x="-7" y="0" width="14" height="8" rx="2" fill="${theme.panel}" stroke="${theme.robotStroke}" stroke-width="1.1" />`,
    `<circle cx="-3" cy="4" r="1.6" fill="${theme.robotEye}">`,
    `<animate attributeName="cy" values="4;3.4;4" dur="1.1s" repeatCount="indefinite" />`,
    `</circle>`,
    `<circle cx="3" cy="4" r="1.6" fill="${theme.robotEye}">`,
    `<animate attributeName="cy" values="4;3.4;4" dur="1.1s" repeatCount="indefinite" />`,
    `</circle>`,
    `<rect x="-4" y="8.5" width="8" height="1.8" rx="0.9" fill="${theme.robotStroke}">`,
    `<animate attributeName="width" values="8;6;8" dur="1.6s" repeatCount="indefinite" />`,
    `</rect>`,
    `</g>`,
    `<animateMotion dur="${motionDuration}s" repeatCount="indefinite" rotate="auto">`,
    `<mpath href="#scanPath" xlink:href="#scanPath" />`,
    `</animateMotion>`,
    `</g>`,
    `<circle cx="0" cy="0" r="4.4" fill="${theme.accentStrong}" opacity="0.85">`,
    `<animate attributeName="r" values="3;8;3" dur="1.6s" repeatCount="indefinite" />`,
    `<animate attributeName="opacity" values="0.85;0.2;0.85" dur="1.6s" repeatCount="indefinite" />`,
    `<animateMotion dur="${motionDuration}s" repeatCount="indefinite">`,
    `<mpath href="#scanPath" xlink:href="#scanPath" />`,
    `</animateMotion>`,
    `</circle>`,
    `</g>`,
    `<text x="${metrics.centerX}" y="${metrics.height - 20}" text-anchor="middle" fill="${theme.muted}" font-size="11" font-family="Inter, Segoe UI, Arial, sans-serif">Generated automatically from your contribution graph</text>`,
    `</svg>`,
  ].join("");
}

function getCellTopLeft(day, metrics) {
  return {
    x: metrics.offsetX + day.weekIndex * (metrics.cell + metrics.gap),
    y: metrics.offsetY + day.weekday * (metrics.cell + metrics.gap),
  };
}

function getCellCenter(day, metrics) {
  const point = getCellTopLeft(day, metrics);
  return {
    x: point.x + metrics.cell / 2,
    y: point.y + metrics.cell / 2,
  };
}

function buildPath(points) {
  if (points.length === 0) {
    return "M 0 0";
  }

  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)} L ${(point.x + 0.01).toFixed(2)} ${point.y.toFixed(2)}`;
  }

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

function getContributionColor(count, maxCount, theme) {
  const ratio = count / maxCount;
  if (ratio < 0.34) {
    return theme.low;
  }
  if (ratio < 0.67) {
    return theme.medium;
  }
  return theme.high;
}

function buildMonthLabels(days, metrics) {
  const labels = [];
  let previousMonth = "";

  for (const day of days) {
    if (day.weekday !== 0) {
      continue;
    }

    const date = new Date(day.date);
    const monthLabel = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    if (monthLabel === previousMonth) {
      continue;
    }

    labels.push({
      text: monthLabel,
      x: metrics.offsetX + day.weekIndex * (metrics.cell + metrics.gap),
    });
    previousMonth = monthLabel;
  }

  return labels;
}

function groupDaysIntoWeeks(days) {
  const weekOrder = [];
  const weekMap = new Map();

  for (const day of days) {
    const weekStart = startOfWeek(day.date);
    if (!weekMap.has(weekStart)) {
      weekMap.set(weekStart, []);
      weekOrder.push(weekStart);
    }

    weekMap.get(weekStart).push({
      date: day.date,
      weekday: day.weekday,
      contributionCount: day.contributionCount,
    });
  }

  return weekOrder.map((weekStart) => {
    const contributionDays = weekMap
      .get(weekStart)
      .slice()
      .sort((left, right) => left.weekday - right.weekday);

    return { contributionDays };
  });
}

function startOfWeek(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);
  return formatDateForQuery(date);
}

function formatDateForQuery(date) {
  return date.toISOString().slice(0, 10);
}

function formatDate(dateValue) {
  return new Date(dateValue).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
