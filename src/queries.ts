/**
 * Shared GraphQL queries and mutations used across multiple commands.
 * Single source of truth — no duplicate query strings.
 */

export const GET_CART = `
  query TripPlanCart($tripPlanId: String!) {
    getTripPlanCart(tripPlanId: $tripPlanId) {
      items {
        id
        name
        description
        price
        currency
        type
        selectionId
        optionId
        subSelectionOptionId
      }
      itemCount
      total
      currency
    }
  }
`;

export const GET_PLAN_DEEP = `
  query TripPlanDeep($id: String!) {
    tripPlan(id: $id) {
      id
      title
      items {
        id
        title
        selection {
          id
          isLocked
          selectedOption {
            id
            name
            price
            status
            subSelections {
              id
              type
              selectedOptionId
              selectedOption { id name price description }
              options {
                id
                name
                description
                price
                currency
                optionType
                status
                isBookable
                sortOrder
              }
            }
          }
        }
      }
    }
  }
`;

export const CREATE_CHECKOUT = `
  mutation CreateTripPlanCheckout($input: CreateTripPlanCheckoutInput!) {
    createTripPlanCheckout(input: $input) {
      url
    }
  }
`;

export const GET_PAYMENT_CHECKOUTS = `
  query TripPlanPaymentCheckouts($tripPlanId: String!) {
    tripPlanPaymentCheckouts(tripPlanId: $tripPlanId) {
      id
      status
      checkoutUrl
      createdAt
      bookingRecords {
        id
        type
        status
        pnr
        providerReference
        amount
      }
    }
  }
`;

export const SET_SUB_SELECTION = `
  mutation SetTripPlanSubSelectionOption($subSelectionId: String!, $optionId: String!) {
    setTripPlanSubSelectionOption(subSelectionId: $subSelectionId, optionId: $optionId) {
      id
      selectedOptionId
      selectedOption {
        id
        name
        price
      }
    }
  }
`;

export const REFRESH_SUB_SELECTION = `
  mutation RefreshTripPlanSubSelectionOptions($subSelectionId: String!) {
    refreshTripPlanSubSelectionOptions(subSelectionId: $subSelectionId) {
      id
      name
      description
      price
      optionType
      status
      isBookable
      sortOrder
    }
  }
`;
