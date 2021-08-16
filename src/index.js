import { Client } from "@notionhq/client";
import moment from "moment";
import ChartJSImage from "chart.js-image";
import log from "loglevel";
import fs from "fs";

const notion = new Client({ auth: process.env.NOTION_KEY });
log.setLevel("info");

const {
  DATABASE_ID_BACKLOG: DB_ID_BACKLOG,
  DATABASE_ID_SPRINT_SUMMARY: DB_ID_SPRINT_SUMMARY,
  DATABASE_ID_DAILY_SUMMARY: DB_ID_DAILY_SUMMARY,
  BACKLOG_PROPERTY_SPRINT,
  BACKLOG_PROPERTY_EXCLUDE_STATUS_PATTERN,
  BACKLOG_PROPERTY_STORY_POINTS,
  MODE
} = process.env;
const INCLUDE_WEEKENDS = process.env["INCLUDE_WEEKENDS"] === "0";

log.info(JSON.stringify({ MODE }));

const getLatestSprintSummary = async () => {
  const response = await notion.databases.query({
    database_id: DB_ID_SPRINT_SUMMARY,
    sorts: [
      {
        property: BACKLOG_PROPERTY_SPRINT,
        direction: "descending",
      },
    ],
  });
  const { properties } = response.results[0];
  const { Sprint, Start, End } = properties;
  return {
    sprint: Sprint.number,
    start: moment(Start.date.start),
    end: moment(End.date.start),
  };
};

const countPointsLeftInSprint = async (sprint) => {
  const response = await notion.databases.query({
    database_id: DB_ID_BACKLOG,
    filter: {
      property: BACKLOG_PROPERTY_SPRINT,
      select: {
        equals: `Sprint ${sprint}`,
      },
    },
  });
  const sprintStories = response.results;
  const ongoingStories = sprintStories.filter(
    (item) =>
      !new RegExp(BACKLOG_PROPERTY_EXCLUDE_STATUS_PATTERN).test(
        item.properties.Status.select.name
      )
  );
  return ongoingStories.reduce((accum, item) => {
    if (item.properties[BACKLOG_PROPERTY_STORY_POINTS]) {
      // Only including stories with numeric estimates
      const points = parseInt(
        item.properties[BACKLOG_PROPERTY_STORY_POINTS].select.name,
        10
      );
      if (!Number.isNaN(points)) {
        return accum + points;
      }
    }
    return accum;
  }, 0);
};

const updateDailySummaryTable = async (sprint, pointsLeft) => {
  const today = moment().startOf("day").format("YYYY-MM-DD");
  await notion.pages.create({
    parent: {
      database_id: DB_ID_DAILY_SUMMARY,
    },
    properties: {
      Name: {
        title: [
          {
            text: {
              content: `Sprint ${sprint} - ${today}`,
            },
          },
        ],
      },
      Sprint: {
        number: sprint,
      },
      Points: {
        number: pointsLeft,
      },
      Date: {
        date: { start: today, end: null },
      },
    },
  });
};

const getChartDatasets = async (sprint, start, includedEnd) => {
  // set the end one day later to include the end
  // note that the new variable end is the excluded day
  // if the sprint is 1 to 4 June (inclusive), then
  // start = 1 June, 0000h
  // includedEnd = 4 June, 0000h
  // end = 5 June, 0000h --> this includes the entire day of 4 June
  /** date after the actual end date (excluded) */
  const end = moment(includedEnd).add(1, "days");
  const numDaysInSprint = moment(end).diff(start, "days");
  // cool way to generate numbers from 1 to n
  const labels = [...Array(numDaysInSprint).keys()].map((i) => i + 1);

  const response = await notion.databases.query({
    database_id: DB_ID_DAILY_SUMMARY,
    filter: {
      property: "Sprint",
      number: {
        equals: sprint,
      },
    },
    sorts: [
      {
        property: "Date",
        direction: "ascending",
      },
    ],
  });
  const pointsLeftByDay = [];
  response.results.forEach((result) => {
    const { properties } = result;
    const { Date, Points } = properties;
    const day = moment(Date.date.start).diff(start, "days");
    if (pointsLeftByDay[day]) {
      log.warn(
        JSON.stringify({
          message: "Found duplicate entry",
          date: Date.date.start,
          points: Points.number,
        })
      );
    }
    pointsLeftByDay[day] = Points.number;
  });
  const numDaysSinceSprintStart = moment().startOf("day").diff(start, "days");
  for (let i = 0; i < numDaysSinceSprintStart; i += 1) {
    if (!pointsLeftByDay[i]) {
      pointsLeftByDay[i] = 0;
    }
  }

  const initialPoints = pointsLeftByDay[0];
  /** range from 0 to 6 */
  const startDayOfWeek = start.day();
  /** range from 0 to 13 but always fulfils startDayOfWeek <= endDayOfWeek < startDayOfWeek + 7 */
  const endDayOfWeek = end.day() >= startDayOfWeek ? end.day() : end.day() + 7;
  // if startDayOfWeek == endDayOfWeek, then there is no extra "short week"
  const extraSat = startDayOfWeek <= 6 && endDayOfWeek > 6;
  const extraSun =
    (startDayOfWeek <= 0 && endDayOfWeek > 0) ||
    (startDayOfWeek <= 7 && endDayOfWeek > 7);
  const numberOfWeekends =
    // number of complete weeks
    Math.floor(numDaysInSprint / 7) * 2 +
    // weekends in the extra "short week"
    extraSat +
    extraSun;
  const numberOfWeekdays = numDaysInSprint - numberOfWeekends;
  const pointsPerDay =
    initialPoints / (INCLUDE_WEEKENDS ? numDaysInSprint : numberOfWeekdays - 1);

  log.info(
    JSON.stringify({
      initialPoints,
      numDaysInSprint,
      numberOfWeekends,
      numberOfWeekdays,
      pointsPerDay,
    })
  );

  const guideline = [];
  const cur = moment(start);
  for (let index = 0; index < numDaysInSprint; index++, cur.add(1, "days")) {
    guideline[index] =
      index === 0
        ? initialPoints
        : guideline[index - 1] -
          (!INCLUDE_WEEKENDS && cur.day() < 2 ? 0 : pointsPerDay);
    // deduct based on the previous day
    // if cur.day() is 0 or 1 means the previous day was 6 (sat) or 0 (sun)
  }

  return { labels, pointsLeftByDay, guideline };
};

const generateChart = (data, guideline, labels) => {
  const chart = ChartJSImage()
    .chart({
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Burndown",
            borderColor: "#ef4444",
            backgroundColor: "rgba(255,+99,+132,+.5)",
            data,
          },
          {
            label: "Constant",
            borderColor: "#cad0d6",
            backgroundColor: "rgba(54,+162,+235,+.5)",
            data: guideline,
          },
        ],
      },
      options: {
        title: {
          display: true,
          text: "Sprint Burndown",
        },
        legend: { display: false },
        scales: {
          xAxes: [
            {
              scaleLabel: {
                display: true,
                labelString: "Day",
              },
            },
          ],
          yAxes: [
            {
              stacked: false,
              scaleLabel: {
                display: true,
                labelString: "Points Left",
              },
              ticks: {
                beginAtZero: true,
                max: Math.max(...data),
              },
            },
          ],
        },
      },
    }) // Line chart
    .backgroundColor("white")
    .width(500) // 500px
    .height(300); // 300px
  return chart;
};

const writeChartToFile = async (chart, dir, filenamePrefix) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  await chart.toFile(`${dir}/${filenamePrefix}-burndown.png`);
};

const updateSprintSummary = async () => {
  const { sprint, start, end } = await getLatestSprintSummary();
  log.info(
    JSON.stringify({ message: "Found latest sprint", sprint, start, end })
  );

  const pointsLeftInSprint = await countPointsLeftInSprint(sprint);
  log.info(
    JSON.stringify({
      message: "Counted points left in sprint",
      sprint,
      pointsLeftInSprint,
    })
  );

  await updateDailySummaryTable(sprint, pointsLeftInSprint);
  log.info(
    JSON.stringify({
      message: "Updated daily summary table",
      sprint,
      pointsLeftInSprint,
    })
  );

  const {
    labels,
    pointsLeftByDay: data,
    guideline,
  } = await getChartDatasets(sprint, start, end);
  log.info(JSON.stringify({ labels, data, guideline }));
  const chart = generateChart(data, guideline, labels);
  await writeChartToFile(chart, "./out", `sprint${sprint}-${Date.now()}`);
  await writeChartToFile(chart, "./out", `sprint${sprint}-latest`);
  log.info(
    JSON.stringify({ message: "Generated burndown chart", sprint, data })
  );
};

updateSprintSummary();
