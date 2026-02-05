export class SearchWidget {
  render() {
    return "SearchWidget";
  }
}

export function findMatches(input: string) {
  return input.includes("match");
}

export const SEARCH_TOKEN = "SearchWidget";
