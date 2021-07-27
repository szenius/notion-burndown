import { Client } from "@notionhq/client";
import moment from "moment";
import ChartJSImage from "chart.js-image";

const notion = new Client({ auth: process.env.NOTION_KEY });
const databaseIdBacklog = process.env.NOTION_DATABASE_ID_BACKLOG;
const databaseIdSprintSummary = process.env.NOTION_DATABASE_ID_SPRINT_SUMMARY;
const databaseIdPointsLeft = process.env.NOTION_DATABASE_ID_POINTS_LEFT;

const getLatestSprintSummary = async () => {
  const response = await notion.databases.query({
    database_id: databaseIdSprintSummary,
    sorts: [
      {
        property: "Sprint",
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
    database_id: databaseIdBacklog,
    filter: {
      property: "Sprint",
      text: {
        equals: `Sprint ${sprint}`,
      },
    },
  });
  const sprintStories = response.results;
  const ongoingStories = sprintStories.filter(
    (item) => item.properties.Status.select.name !== "Done 🙌"
  );
  return ongoingStories.reduce(
    (accum, item) => accum + item.properties.Points.number,
    0
  );
};

const updatePointsLeftTable = async (sprint, pointsLeft) => {
  const today = moment().startOf("day").format("YYYY-MM-DD");
  await notion.pages.create({
    parent: {
      database_id: databaseIdPointsLeft,
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

const getPointsLeftByDay = async (sprint, start, end) => {
  const response = await notion.databases.query({
    database_id: databaseIdPointsLeft,
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
  const numDaysInSprint = moment().startOf("day").diff(start, "days");
  for (let i = 0; i < numDaysInSprint; i += 1) {
    if (!pointsLeftByDay[i]) {
      pointsLeftByDay[i] = 0;
    }
  }
  return pointsLeftByDay;
};

const generateChart = async (data, labels) => {
  const chart = ChartJSImage()
    .chart({
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Burndown",
            borderColor: "rgb(255,+99,+132)",
            backgroundColor: "rgba(255,+99,+132,+.5)",
            data,
          },
        ],
      },
      options: {
        title: {
          display: true,
          text: "Sprint Burndown",
        },
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

const updateSprintSummary = async () => {
  const { sprint, start, end } = await getLatestSprintSummary();
  const pointsLeftInSprint = await countPointsLeftInSprint(sprint);
  await updatePointsLeftTable(sprint, pointsLeftInSprint);
  const chartData = await getPointsLeftByDay(sprint, start, end);
  await generateChart(
    chartData.slice(0, moment().startOf("day").diff(start) + 1),
    chartData.map((_, i) => i)
  );
};

updateSprintSummary();
