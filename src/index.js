import { Client } from "@notionhq/client";
import lodash from "lodash";
import moment from "moment";
import ChartJSImage from "chart.js-image";

const notion = new Client({ auth: process.env.NOTION_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

const SPRINT_NUM = 1;

const run = async () => {
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: "Sprint",
      text: {
        equals: `Sprint ${SPRINT_NUM}`,
      },
    },
  });

  const sprintItems = response.results; // TODO: define sprint start time and end time
  const totalPointsInSprint = sprintItems.reduce(
    (accum, item) => accum + item.properties.Points.number,
    0
  );

  const doneItems = sprintItems.filter(
    (item) => item.properties.Status.select.name === "Done 🙌"
  );
  const donePointsByDay = {};
  doneItems.forEach((item) => {
    const lastEditedDay = moment(item.last_edited_time).startOf("day").unix();
    if (!donePointsByDay[lastEditedDay]) {
      donePointsByDay[lastEditedDay] = 0;
    }
    donePointsByDay[lastEditedDay] += item.properties.Points.number;
  });

  const chartData = Object.entries(donePointsByDay).map(([key, value]) => ({
    timestamp: key,
    points: value,
  }));
  const chartDataSorted = lodash.orderBy(chartData, "timestamp", "asc");

  const chart = ChartJSImage()
    .chart({
      type: "line",
      data: {
        labels: chartDataSorted.map((data) => data.timestamp),
        datasets: [
          {
            label: "Burndown",
            borderColor: "rgb(255,+99,+132)",
            backgroundColor: "rgba(255,+99,+132,+.5)",
            data: chartDataSorted.map((data) => data.points),
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
                labelString: "Time",
              },
            },
          ],
          yAxes: [
            {
              stacked: false,
              scaleLabel: {
                display: true,
                labelString: "Value",
              },
            },
          ],
        },
      },
    }) // Line chart
    .backgroundColor("white")
    .width(500) // 500px
    .height(300); // 300px

  await chart.toFile("test.png");
};

run().then(() => console.log("done"));
