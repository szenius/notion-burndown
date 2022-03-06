const { Client } = require("@notionhq/client");
const moment = require("moment-timezone");
moment.tz.setDefault("Asia/Hong_Kong");
const ChartJSImage = require("chart.js-image");
const log = require("loglevel");
const fs = require("fs");
const core = require("@actions/core");

log.setLevel("info");
require("dotenv").config();

const parseConfig = () => {
  if (process.env.NODE_ENV === "offline") {
    return {
      notion: {
        client: new Client({ auth: process.env.NOTION_KEY }),
        databases: {
          backlog: process.env.NOTION_DB_BACKLOG,
          sprintSummary: process.env.NOTION_DB_SPRINT_SUMMARY,
          dailySummary: process.env.NOTION_DB_DAILY_SUMMARY,
        },
        options: {
          sprintProp: process.env.NOTION_PROPERTY_SPRINT,
          estimateProp: process.env.NOTION_PROPERTY_ESTIMATE,
          statusInclude: process.env.NOTION_PROPERTY_PATTERN_STATUS_INCLUDE,
        },
      },
      chartOptions: {
        isIncludeWeekends: process.env.INCLUDE_WEEKENDS !== "false",
      },
    };
  }
  return {
    notion: {
      client: new Client({ auth: core.getInput("NOTION_KEY") }),
      databases: {
        backlog: core.getInput("NOTION_DB_BACKLOG"),
        sprintSummary: core.getInput("NOTION_DB_SPRINT_SUMMARY"),
        dailySummary: core.getInput("NOTION_DB_DAILY_SUMMARY"),
      },
      options: {
        sprintProp: core.getInput("NOTION_PROPERTY_SPRINT"),
        estimateProp: core.getInput("NOTION_PROPERTY_ESTIMATE"),
        statusInclude: core.getInput("NOTION_PROPERTY_PATTERN_STATUS_INCLUDE"),
      },
    },
    chartOptions: {
      isIncludeWeekends: core.getInput("INCLUDE_WEEKENDS") !== "false",
    },
  };
};

const getLatestSprintSummary = async (
  notion,
  sprintSummaryDb,
  { sprintProp }
) => {
  const response = await notion.databases.query({
    database_id: sprintSummaryDb,
    sorts: [
      {
        property: sprintProp,
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
  backlogDb,
  sprint,
  { sprintProp, estimateProp, statusInclude }
) => {
  const response = await notion.databases.query({
    database_id: backlogDb,
    filter: {
      property: sprintProp,
      select: {
        equals: `Sprint ${sprint}`,
      },
    },
  });
  const sprintStories = response.results;
  const ongoingStories = sprintStories.filter(
    (item) =>
      new RegExp(statusInclude).test(item.properties.Status.select.name)
  );
  return ongoingStories.reduce((accum, item) => {
    if (item.properties[estimateProp]) {
      const points = item.properties[estimateProp].number;
      return accum + points;
    }
    return accum;
  }, 0);
};

const updateDailySummaryTable = async (
  notion,
  dailySummaryDb,
  sprint,
  pointsLeft
) => {
  const today = moment().startOf("day").format("YYYY-MM-DD");
  await notion.pages.create({
    parent: {
      database_id: dailySummaryDb,
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
  dailySummaryDb,
  sprint,
  start,
  isIncludeWeekends
) => {
  const response = await notion.databases.query({
    database_id: dailySummaryDb,
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
    console.log('results: ', result)
    const { properties } = result;
    console.log('properties: ', properties)
    console.log('properties.Date: ', properties.Date)
    console.log('properties.Points: ', properties.Points)
    const { Date: date, Points: points } = properties;
    console.log('Date: ', date)
    try {
      console.log('Trying to print Date.date')
      console.log(date.date)
      console.log(date.date.start)
    } catch (e) {
      console.log('Failed to print Date.date')
      console.error(e)
    }
    console.log('Points: ', date)
    const day = moment(date.date.start).diff(start, "days");
    if (pointsLeftByDay[day]) {
      log.warn(
        JSON.stringify({
          message: "Found duplicate entry",
          date: date.date.start,
          points: points.number,
        })
      );
    }
    pointsLeftByDay[day] = points.number;
  });
  const numDaysSinceSprintStart = moment().startOf("day").diff(start, "days");
  for (let i = 0; i < numDaysSinceSprintStart; i += 1) {
    if (!pointsLeftByDay[i]) {
      pointsLeftByDay[i] = 0;
    }
  }
  log.info(JSON.stringify({ numDaysSinceSprintStart }));

  if (!isIncludeWeekends) {
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
 * @param {number} numWeekdays Number of working days in the sprint
 * @returns {number[]} Array of the ideal points left per day
 */
const getIdealBurndown = (
  start,
  end,
  initialPoints,
  numWeekdays,
  isIncludeWeekends
) => {
  const pointsPerDay = initialPoints / numWeekdays;

  log.info(
    JSON.stringify({
      initialPoints,
      numWeekdays,
      pointsPerDay,
    })
  );

  const idealBurndown = [];
  const cur = moment(start);
  const afterEnd = moment(end).add(1, "days"); // to include the end day data point
  let isPrevDayWeekday = false;
  for (let index = 0; cur.isBefore(afterEnd); index += 1, cur.add(1, "days")) {
    // if not including the weekends, just skip over the weekend days
    if (!isIncludeWeekends) {
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
  dailySummaryDb,
  sprint,
  start,
  end,
  { isIncludeWeekends }
) => {
  const numDaysInSprint = moment(end).diff(start, "days") + 1;
  const lastFullDay = moment(end).add(-1, "days");
  const numWeekdays = getNumberOfWeekdays(start, lastFullDay);

  const pointsLeftByDay = await getPointsLeftByDay(
    notion,
    dailySummaryDb,
    sprint,
    start,
    isIncludeWeekends
  );
  const idealBurndown = getIdealBurndown(
    start,
    end,
    pointsLeftByDay[0],
    numWeekdays,
    isIncludeWeekends
  );
  const labels = getChartLabels(
    isIncludeWeekends ? numDaysInSprint : numWeekdays + 1
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

const run = async () => {
  const { notion, chartOptions } = parseConfig();

  const { sprint, start, end } = await getLatestSprintSummary(
    notion.client,
    notion.databases.sprintSummary,
    { sprintProp: notion.options.sprintProp }
  );
  log.info(
    JSON.stringify({ message: "Found latest sprint", sprint, start, end })
  );

  const pointsLeftInSprint = await countPointsLeftInSprint(
    notion.client,
    notion.databases.backlog,
    sprint,
    {
      sprintProp: notion.options.sprintProp,
      estimateProp: notion.options.estimateProp,
      statusInclude: notion.options.statusInclude,
    }
  );
  log.info(
    JSON.stringify({
      message: "Counted points left in sprint",
      sprint,
      pointsLeftInSprint,
    })
  );

  await updateDailySummaryTable(
    notion.client,
    notion.databases.dailySummary,
    sprint,
    pointsLeftInSprint
  );
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
    notion.client,
    notion.databases.dailySummary,
    sprint,
    start,
    end,
    {
      isIncludeWeekends: chartOptions.isIncludeWeekends,
    }
  );
  log.info(JSON.stringify({ labels, data, idealBurndown }));
  const chart = generateChart(data, idealBurndown, labels);

  await writeChartToFile(chart, "./out", `sprint${sprint}-latest`);
  await writeChartToFile(chart, "./out", `latest`);
  log.info(
    JSON.stringify({ message: "Generated burndown chart", sprint, data })
  );
};

run();
