const { Client } = require("@notionhq/client");
const moment = require("moment");
const ChartJSImage = require("chart.js-image");
const log = require("loglevel");
const fs = require("fs");
const core = require("@actions/core");
const github = require("@actions/github");

log.setLevel("info");
require("dotenv").config();

const getLatestSprintSummary = async (
  notion,
  { NOTION_DB_SPRINT_SUMMARY, NOTION_PROPERTY_SPRINT }
) => {
  const response = await notion.databases.query({
    database_id: NOTION_DB_SPRINT_SUMMARY,
    sorts: [
      {
        property: NOTION_PROPERTY_SPRINT,
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

const countPointsLeftInSprint = async (
  notion,
  sprint,
  {
    NOTION_DB_BACKLOG,
    NOTION_PROPERTY_SPRINT,
    NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE,
    NOTION_PROPERTY_ESTIMATE,
  }
) => {
  const response = await notion.databases.query({
    database_id: NOTION_DB_BACKLOG,
    filter: {
      property: NOTION_PROPERTY_SPRINT,
      select: {
        equals: `Sprint ${sprint}`,
      },
    },
  });
  const sprintStories = response.results;
  const ongoingStories = sprintStories.filter(
    (item) =>
      !new RegExp(NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE).test(
        item.properties.Status.select.name
      )
  );
  return ongoingStories.reduce((accum, item) => {
    if (item.properties[NOTION_PROPERTY_ESTIMATE]) {
      const points = item.properties[NOTION_PROPERTY_ESTIMATE].number;
      return accum + points;
    }
    return accum;
  }, 0);
};

const updateDailySummaryTable = async (
  notion,
  sprint,
  pointsLeft,
  { NOTION_DB_DAILY_SUMMARY }
) => {
  const today = moment().startOf("day").format("YYYY-MM-DD");
  await notion.pages.create({
    parent: {
      database_id: NOTION_DB_DAILY_SUMMARY,
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

/**
 * Calculates the number of weekdays from {@link start} to {@link end}
 * @param {moment.Moment} start First day of sprint (inclusive)
 * @param {moment.Moment} end Last day of sprint (inclusive)
 * @returns number of weekdays between both dates
 */
const getNumberOfWeekdays = (start, end) => {
  let weekdays = 0;
  for (const cur = moment(start); !cur.isAfter(end); cur.add(1, "days")) {
    if (!isWeekend(cur)) {
      weekdays += 1;
    }
  }
  return weekdays;
};

/**
 * Calculates the points left for each day of the sprint so far
 * @param {number} sprint Sprint number of current sprint
 * @param {moment.Moment} start First day of sprint (inclusive)
 * @returns {number[]} Array of points left each day from {@link start} till today (inclusive)
 * */
const getPointsLeftByDay = async (
  notion,
  sprint,
  start,
  isWeekendsIncluded,
  { NOTION_DB_DAILY_SUMMARY }
) => {
  const response = await notion.databases.query({
    database_id: NOTION_DB_DAILY_SUMMARY,
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
  log.info(JSON.stringify({ numDaysSinceSprintStart }));

  if (!isWeekendsIncluded) {
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
        index += 1;
      }
    }
  }

  return pointsLeftByDay;
};
/**
 * Generates the ideal burndown line for the sprint. Work is assumed to be done on
 * each weekday from {@link start} until the day before {@link end}. A data point is
 * generated for {@link end} to show the final remaining points.
 *
 * A flat line is shown across weekends if {@link isWeekendsIncluded} is set to true,
 * else, the weekends are not shown.
 * @param {moment.Moment} start The start of the sprint (inclusive)
 * @param {moment.Moment} end The end of the sprint (inclusive)
 * @param {number} initialPoints Points the sprint started with
 * @param {number} numberOfWeekdays Number of working days in the sprint
 * @returns {number[]} Array of the ideal points left per day
 */
const getIdealBurndown = (
  start,
  end,
  initialPoints,
  numberOfWeekdays,
  isWeekendsIncluded
) => {
  const pointsPerDay = initialPoints / numberOfWeekdays;

  log.info(
    JSON.stringify({
      initialPoints,
      numberOfWeekdays,
      pointsPerDay,
    })
  );

  const idealBurndown = [];
  const cur = moment(start);
  const afterEnd = moment(end).add(1, "days"); // to include the end day data point
  let isPrevDayWeekday = false;
  for (let index = 0; cur.isBefore(afterEnd); index += 1, cur.add(1, "days")) {
    // if not including the weekends, just skip over the weekend days
    if (!isWeekendsIncluded) {
      while (isWeekend(cur)) {
        cur.add(1, "days");
      }
    }

    if (index === 0) {
      idealBurndown[index] = initialPoints;
    } else {
      idealBurndown[index] =
        idealBurndown[index - 1] - (isPrevDayWeekday ? pointsPerDay : 0);
    }

    isPrevDayWeekday = !isWeekend(cur);
  }

  // rounds to 2 decimal places, which prevents the graph from getting jagged
  // from overtruncation when there's less than 30 points
  return idealBurndown.map((points) => +points.toFixed(2));
};

/**
 * Generates the labels for the chart from 1 to {@link numberOfDays} + 1
 * to have a data point for after the last day.
 * @param {number} numberOfDays Number of workdays in the sprint
 * @returns {number[]} Labels for the chart
 */
const getChartLabels = (numberOfDays) =>
  // cool way to generate numbers from 1 to n
  [...Array(numberOfDays).keys()].map((i) => i + 1);
/**
 * Generates the data to be displayed on the chart. Work is assumed to be
 * done on each day from the start until the day before {@link end}.
 * @param {number} sprint Current sprint number
 * @param {moment.Moment} start Start date of sprint (included)
 * @param {moment.Moment} end End date of sprint (excluded)
 * @returns The chart labels, data line, and ideal burndown line
 */
const getChartDatasets = async (
  notion,
  sprint,
  start,
  end,
  isWeekendsIncluded,
  { NOTION_DB_DAILY_SUMMARY }
) => {
  const numDaysInSprint = moment(end).diff(start, "days") + 1;
  const lastFullDay = moment(end).add(-1, "days");
  const numWeekdays = getNumberOfWeekdays(start, lastFullDay);

  const pointsLeftByDay = await getPointsLeftByDay(
    notion,
    sprint,
    start,
    isWeekendsIncluded,
    { NOTION_DB_DAILY_SUMMARY }
  );
  const idealBurndown = getIdealBurndown(
    start,
    end,
    pointsLeftByDay[0],
    numWeekdays,
    isWeekendsIncluded
  );
  const labels = getChartLabels(
    isWeekendsIncluded ? numDaysInSprint : numWeekdays + 1
  );

  return { labels, pointsLeftByDay, idealBurndown };
};

const generateChart = (data, idealBurndown, labels) => {
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
            data: idealBurndown,
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

const parseConfig = () => {
  if (process.env.NODE_ENV === "offline") {
    return {
      notion: new Client({ auth: process.env.NOTION_KEY }),
      NOTION_DB_BACKLOG: process.env.NOTION_DB_BACKLOG,
      NOTION_DB_SPRINT_SUMMARY: process.env.NOTION_DB_SPRINT_SUMMARY,
      NOTION_DB_DAILY_SUMMARY: process.env.NOTION_DB_DAILY_SUMMARY,
      NOTION_PROPERTY_SPRINT: process.env.NOTION_PROPERTY_SPRINT,
      NOTION_PROPERTY_ESTIMATE: process.env.NOTION_PROPERTY_ESTIMATE,
      NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE:
        process.env.NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE,
      INCLUDE_WEEKENDS: process.env.INCLUDE_WEEKENDS !== "false",
    };
  }
  return {
    notion: new Client({ auth: core.getInput("NOTION_KEY") }),
    NOTION_DB_BACKLOG: core.getInput("NOTION_DB_BACKLOG"),
    NOTION_DB_SPRINT_SUMMARY: core.getInput("NOTION_DB_SPRINT_SUMMARY"),
    NOTION_DB_DAILY_SUMMARY: core.getInput("NOTION_DB_DAILY_SUMMARY"),
    NOTION_PROPERTY_SPRINT: core.getInput("NOTION_PROPERTY_SPRINT"),
    NOTION_PROPERTY_ESTIMATE: core.getInput("NOTION_PROPERTY_ESTIMATE"),
    NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE: core.getInput(
      "NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE"
    ),
    INCLUDE_WEEKENDS: core.getInput("INCLUDE_WEEKENDS") !== "false",
  };
};

const run = async () => {
  const {
    notion,
    NOTION_DB_BACKLOG,
    NOTION_DB_SPRINT_SUMMARY,
    NOTION_DB_DAILY_SUMMARY,
    NOTION_PROPERTY_SPRINT,
    NOTION_PROPERTY_ESTIMATE,
    NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE,
    INCLUDE_WEEKENDS,
  } = parseConfig();

  const { sprint, start, end } = await getLatestSprintSummary(notion, {
    NOTION_DB_SPRINT_SUMMARY,
    NOTION_PROPERTY_SPRINT,
  });
  log.info(
    JSON.stringify({ message: "Found latest sprint", sprint, start, end })
  );

  const pointsLeftInSprint = await countPointsLeftInSprint(notion, sprint, {
    NOTION_DB_BACKLOG,
    NOTION_PROPERTY_SPRINT,
    NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE,
    NOTION_PROPERTY_ESTIMATE,
  });
  log.info(
    JSON.stringify({
      message: "Counted points left in sprint",
      sprint,
      pointsLeftInSprint,
    })
  );

  await updateDailySummaryTable(notion, sprint, pointsLeftInSprint, {
    NOTION_DB_DAILY_SUMMARY,
  });
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
    idealBurndown,
  } = await getChartDatasets(
    notion,
    sprint,
    start,
    end,
    INCLUDE_WEEKENDS === "true",
    { NOTION_DB_DAILY_SUMMARY }
  );
  log.info(JSON.stringify({ labels, data, idealBurndown }));
  const chart = generateChart(data, idealBurndown, labels);

  await writeChartToFile(chart, "./out", `sprint${sprint}-${Date.now()}`);
  await writeChartToFile(chart, "./out", `sprint${sprint}-latest`);
  log.info(
    JSON.stringify({ message: "Generated burndown chart", sprint, data })
  );
};

run();
