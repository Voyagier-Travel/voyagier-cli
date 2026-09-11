/**
 * GraphQL documents the CLI still sends directly.
 *
 * Since 4.0 every trip-planning operation goes through the Voyagier MCP
 * server (`voyagier <tool>`), so the only GraphQL left here backs the local
 * account commands (`voyagier auth setup` profile updates). Do not add
 * trip-planning documents; add a tool on the server instead.
 */

export const UPDATE_MY_USER = `
  mutation UpdateMyUser($input: UpdateUserInput!) {
    updateMyUser(input: $input) {
      passport { last4 issueCountry nationalityCountry expirationDate }
      frequentFlyerPrograms { airlineCode membershipNumber }
    }
  }
`;
