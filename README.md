# notion burndown

Generates burndown charts based on Notion databases.

This goes out to all of us who chose to put our scrum boards on Notion even though it doesn't have proper scrum features... Just because it's \*~aesthetic~\*.

## Set up

1. [Create a Notion integration](https://developers.notion.com/docs/getting-started#step-1-create-an-integration).
   1. Copy down the secret token and store it somewhere safe.
2. You should have one database for your product backlog. On top of that, you need to create two other databases:
   1. Sprint Summary: List of sprints and their information. For the integration to retrieve the latest sprint's information.
      1. Compulsory fields: Sprint (number), Start (Date), End (Date)
   2. Daily Summary: How many points are left in the latest sprint every day.
      1. Compulsory fields: Sprint (number), Date (Date), Points (number)
3. [Give your integration access to all 3 databases.](https://developers.notion.com/docs/getting-started#step-2-share-a-database-with-your-integration)
4. Clone this project.
5. Install dependencies by `npm i`.
6. Set up the .env file. Reference the .env.example and replace the values accordingly.

## Usage

```
npm start
```

A burndown chart PNG file should be generated in the project root directory.

You will need to schedule this script to run once every day.

## Example

Reference [this Notion page](https://foregoing-cub-523.notion.site/Notion-Burndown-Chart-390ba59cef094387900a26f75c108385) to see how I set up my three databases.
