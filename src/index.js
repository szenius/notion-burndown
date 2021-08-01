import { Client } from "@notionhq/client";
import moment from "moment";
import ChartJSImage from "chart.js-image";

const notion = new Client({ auth: process.env.NOTION_KEY });

const DATABASE_ID_BACKLOG = process.env.NOTION_DATABASE_ID_BACKLOG;
const DATABASE_ID_SPRINT_SUMMARY =
  process.env.NOTION_DATABASE_ID_SPRINT_SUMMARY;
const DB_ID_DAILY_SUMMARY = process.env.NOTION_DATABASE_ID_DAILY_SUMMARY;

// TODO: allow as input params
const BACKLOG_PROPERTY_SPRINT = "Sprint";
const BACKLOG_PROPERTY_STATUS_LIST_DEV_DONE = [
  "Ready to Deploy",
  "DONE (In Production 🙌)",
  "DONE (No action required)",
];
const BACKLOG_PROPERTY_STORY_POINTS = "Story Estimate";

const getLatestSprintSummary = async () => {
  const response = await notion.databases.query({
    database_id: DATABASE_ID_SPRINT_SUMMARY,
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
    database_id: DATABASE_ID_BACKLOG,
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
      !BACKLOG_PROPERTY_STATUS_LIST_DEV_DONE.includes(
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
      // eslint-disable-next-line no-console
      console.warn({
        message: "Found duplicate entry",
        date: Date.date.start,
        points: Points.number,
      });
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

const generateChart = async (data, labels) => {
  const pointsPerDay = data[0] / (labels[labels.length - 1] - 1);
  const constantLine = labels.map(
    (label) => data[0] - pointsPerDay * (label - 1)
  );
  // eslint-disable-next-line no-console
  console.log({ constantLine });
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
  await chart.toFile("burndown.png");
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
  // eslint-disable-next-line no-console
  console.log({ message: "Found latest sprint", sprint, start, end });

  // const pointsLeftInSprint = await countPointsLeftInSprint(sprint);
  // // eslint-disable-next-line no-console
  // console.log({
  //   message: "Counted points left in sprint",
  //   sprint,
  //   pointsLeftInSprint,
  // });

  // await updateDailySummaryTable(sprint, pointsLeftInSprint);
  // // eslint-disable-next-line no-console
  // console.log({
  //   message: "Updated daily summary table",
  //   sprint,
  //   pointsLeftInSprint,
  // });

  const chartData = await getPointsLeftByDay(sprint, start, end);
  const chartLabels = getChartLabels(start, end);
  await generateChart(chartData, chartLabels);
  // eslint-disable-next-line no-console
  console.log({ message: "Generated burndown chart", sprint, chartData });
};

updateSprintSummary();
