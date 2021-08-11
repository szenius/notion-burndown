# notion burndown

Generates burndown charts based on Notion databases.

## Usage

### Manual

Run `on_trigger` workflow. The generated burndown chart will be saved to the `out/` folder.

### Scheduled 

At the start of sprint, add a new row in the [Sprint summary](https://www.notion.so/6da452638e6044599f48ddcd9758c04e?v=c2a538f2b0bf41f189089ef4b53f39f9) database.
* Sprint: latest sprint number
* Start: sprint start date
* End: sprint end date
* Name: doesn't really matter
* Burndown Chart: `https://github.com/rationally-app/notion-burndown/blob/master/out/sprint<new sprint number>-latest-burndown.png`

The scheduled workflows will take care of the rest.

## Contribution

Please see [issues in the original repo](https://github.com/szenius/notion-burndown/issues).