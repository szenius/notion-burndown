# notion burndown

Generates burndown charts based on Notion databases.

This goes out to all of us who chose to put our scrum boards on Notion even though it doesn't have proper scrum features... Just because it's \*~aesthetic~\*.

## Setup

1. [Create a Notion integration](https://developers.notion.com/docs/getting-started#step-1-create-an-integration).
   1. Copy down the secret token and store it somewhere safe.
2. You should have one database for your product backlog. On top of that, you need to create two other databases:
   1. Sprint Summary: List of sprints and their information. For the integration to retrieve the latest sprint's information.
      1. Compulsory fields: Sprint (number), Start (Date), End (Date)
   2. Daily Summary: How many points are left in the latest sprint every day.
3. [Give your integration access to all 3 databases.](https://developers.notion.com/docs/getting-started#step-2-share-a-database-with-your-integration)
4.
