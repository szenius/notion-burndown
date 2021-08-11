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
  const numDaysSinceSprintStart = moment().startOf("day").diff(start, "days");
  for (let i = 0; i < numDaysSinceSprintStart; i += 1) {
    if (!pointsLeftByDay[i]) {
      pointsLeftByDay[i] = 0;
    }
  }
  return pointsLeftByDay;
};

const generateChart = async (data, labels, filenamePrefix) => {
  const pointsPerDay = data[0] / (labels[labels.length - 1] - 1);
  const constantLine = labels.map(
    (label) => data[0] - pointsPerDay * (label - 1)
  );
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
            data: constantLine,
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
  const dir = "./out";
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  await chart.toFile(`${dir}/${filenamePrefix}-burndown.png`);
};

const getChartLabels = (start, end) => {
  const chartLabels = [];
  const numDaysInSprint = moment(end).startOf("day").diff(start, "days");
  for (let i = 1; i <= numDaysInSprint; i += 1) {
    chartLabels.push(i);
  }
  return chartLabels;
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

  const chartData = await getPointsLeftByDay(sprint, start, end);
  const chartLabels = getChartLabels(start, end);
  log.info(JSON.stringify({ chartLabels }));
  await generateChart(chartData, chartLabels, `${Date.now()}-sprint${sprint}`);
  log.info(
    JSON.stringify({ message: "Generated burndown chart", sprint, chartData })
  );
};

updateSprintSummary();
