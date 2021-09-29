# notion burndown

Generates burndown charts based on Notion databases.

This goes out to all of us who chose to put our scrum boards on Notion even though it doesn't have proper scrum features... Just because it's \*~aesthetic~\*.

## Set up

### Step 1. One-time setup on Notion

1. [Create a Notion integration](https://developers.notion.com/docs/getting-started#step-1-create-an-integration).
    1. Copy down the secret token and store it somewhere safe.
2. You should have one database for your product backlog. On top of that, you need to create two other databases:
    1. Sprint Summary: List of sprints and their information. For the integration to retrieve the latest sprint's information.
        1. Compulsory fields: Sprint (number), Start (Date), End (Date)
    2. Daily Summary: How many points are left in the latest sprint every day.
        1. Compulsory fields: Sprint (number), Date (Date), Points (number)
3. [Give your integration access to all 3 databases.](https://developers.notion.com/docs/getting-started#step-2-share-a-database-with-your-integration)

### Step 2. Schedule the integration to run daily

This project is published as a GitHub action in the marketplace. You can make use of scheduled GitHub workflows to run it for free.

```
uses: szenius/notion-burndown@1.0.0
with:
    NOTION_KEY: "Notion integration access token"
    NOTION_DB_BACKLOG: "Notion Database ID of Sprint Backlog"
    NOTION_DB_SPRINT_SUMMARY: "Notion Database ID of Sprint Summary"
    NOTION_DB_DAILY_SUMMARY: "Notion Database ID of Daily Summary"
    NOTION_PROPERTY_SPRINT: "Name of the property with the sprint number"
    NOTION_PROPERTY_ESTIMATE: "Name of the property with the estimate"
    NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE: "Regex of the statuses of stories which are done"
    INCLUDE_WEEKENDS: "True if weekends should be included in the chart, false otherwise."
```

See [the scheduled daily workflow](.github/workflows/on_daily.yml) as an example for how you can set up your own.

## Usage

```
npm start
```

A burndown chart PNG file should be generated in the project root directory.

You will need to schedule this script to run once every day. To do so, you can reference [the example GitHub action on_daily workflow](.github/workflows/running_integration).

## Notion Template

Reference [this Notion page](https://szenius.notion.site/Notion-Burndown-Chart-390ba59cef094387900a26f75c108385) to see how I set up my three databases.

The configurations for this example are found in [.env.template](./.env.template).

## Future Work

See issues.
