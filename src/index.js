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
  MODE,
} = process.env;
const INCLUDE_WEEKENDS = (process.env["INCLUDE_WEEKENDS"] ?? "true") === "true";

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

const isWeekend = (date) => {
  const dayOfWeek = moment(date).format("ddd");
  return dayOfWeek === "Sat" || dayOfWeek === "Sun";
};

/** returns the number of weekdays between start (inclusive) and end (exclusive) */
const getNumberOfWeekdays = (start, end) => {
  let weekdays = 0;
  for (const cur = moment(start); cur.isBefore(end); cur.add(1, "days")) {
    if (!isWeekend(cur)) {
      weekdays++;
    }
  }
  return weekdays;
};

/** Returns the points left from the start of sprint (inclusive) to the current day (inclusive) */
const getPointsLeftByDay = async (sprint, start) => {
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
  const today = moment().startOf("day");
  const numDaysSinceSprintStart = today.diff(start, "days");
  for (let i = 0; i < numDaysSinceSprintStart; i += 1) {
    if (!pointsLeftByDay[i]) {
      pointsLeftByDay[i] = 0;
    }
  }
  log.info(JSON.stringify({ numDaysSinceSprintStart }));

  if (!INCLUDE_WEEKENDS) {
    // remove weekend entries
    let index = 0;
    for (
      const cur = moment(start);
      index < pointsLeftByDay.length;
      cur.add(1, "days")
    ) {
      if (isWeekend(cur)) {
        pointsLeftByDay.splice(index, 1);
      } else {
        index++;
      }
    }
  }

  return pointsLeftByDay;
};

/** generate the guideline. A flat line is shown across weekends if {@link INCLUDE_WEEKENDS} is set to true */
const getGuideline = (start, end, initialPoints, numberOfWeekdays) => {
  const pointsPerDay = initialPoints / numberOfWeekdays;

  log.info(
    JSON.stringify({
      initialPoints,
      numberOfWeekdays,
      pointsPerDay,
    })
  );

  const guideline = [];
  const cur = moment(start);
  const afterEnd = moment(end).add(1, "days"); // to include the end day data point
  let prevDayIsWeekday = false;
  for (let index = 0; cur.isBefore(afterEnd); index++, cur.add(1, "days")) {
    // if not including the weekends, just skip over the weekend days
    if (!INCLUDE_WEEKENDS) {
      while (isWeekend(cur)) {
        cur.add(1, "days");
      }
    }

    if (index === 0) {
      guideline[index] = initialPoints;
    } else {
      guideline[index] =
        guideline[index - 1] - (prevDayIsWeekday ? pointsPerDay : 0);
    }

    prevDayIsWeekday = !isWeekend(cur);
  }

  return guideline;
};

const getChartLabels = (numberOfDays) => {
  // cool way to generate numbers from 1 to n
  return [...Array(numberOfDays+1).keys()].map((i) => i + 1);
};

const getChartDatasets = async (sprint, start, end) => {
  const numDaysInSprint = moment(end).diff(start, "days");
  const numberOfWeekdays = getNumberOfWeekdays(start, end);

  const pointsLeftByDay = await getPointsLeftByDay(sprint, start);
  const guideline = getGuideline(
    start,
    end,
    pointsLeftByDay[0],
    numberOfWeekdays
  );
  const labels = getChartLabels(
    INCLUDE_WEEKENDS ? numDaysInSprint : numberOfWeekdays
  );

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
