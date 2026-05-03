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
          type
          isLocked
          assignedTravellers {
            id
            firstName
            lastName
            dateOfBirth
            gender
          }
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

// --- Plans ---

export const CREATE_TRIP_PLAN = `
  mutation CreateTripPlan($input: CreateTripPlanInput!) {
    createTripPlan(input: $input) { id title startDate endDate description }
  }
`;

export const CREATE_TRIP_PLAN_BASIC = `
  mutation CreateTripPlan($input: CreateTripPlanInput!) {
    createTripPlan(input: $input) { id title startDate endDate }
  }
`;

export const GET_TRIP_PLANS = `
  query TripPlans($page: Int, $limit: Int) {
    tripPlans(page: $page, limit: $limit) {
      items { id title startDate endDate }
      count page limit
    }
  }
`;

export const GET_TRIP_PLAN = `
  query TripPlan($id: String!) {
    tripPlan(id: $id) {
      id title description startDate endDate
      items {
        id type title date startTime endTime day
        selection { id selectedOption { id name price status } }
      }
      travellers { id firstName lastName declaredTravellerType }
    }
  }
`;

export const GET_TRIP_PLAN_SUMMARY = `
  query TripPlan($id: String!) {
    tripPlan(id: $id) {
      id title startDate endDate
      items {
        id type title day
        selection { id selectedOption { id name price status } }
      }
      travellers { id firstName lastName declaredTravellerType }
    }
  }
`;

export const GET_TRIP_PLAN_BASIC = `query TripPlan($id: String!) { tripPlan(id: $id) { id title startDate endDate } }`;

export const GET_TRIP_PLAN_WITH_DESC = `query GetPlan($id: String!) { tripPlan(id: $id) { id title startDate endDate description } }`;

export const UPDATE_TRIP_PLAN = `
  mutation UpdateTripPlan($id: String!, $input: UpdateTripPlanInput!) {
    updateTripPlan(id: $id, input: $input) { id }
  }
`;

export const DELETE_TRIP_PLAN = `mutation DeleteTripPlan($id: String!) { deleteTripPlan(id: $id) }`;

export const DELETE_TRIP_PLAN_ITEM = `mutation DeleteTripPlanItem($id: String!) { deleteTripPlanItem(id: $id) }`;

// --- Plans — Sharing ---

export const LOOKUP_USER = `query LookupUser($username: String!) { userPublicProfile(username: $username) { id name username } }`;

export const GET_USERS = `query Users { users(limit: 100) { items { id name email username } } }`;

export const CREATE_USER_INVITATION = `mutation InviteUser($input: CreateUserInvitationInput!) { createUserInvitation(createUserInvitationInput: $input) { __typename } }`;

export const GET_TRIP_PLAN_ROLES = `{ tripPlanRoles { id name } }`;

export const INVITE_COLLABORATOR = `
  mutation Invite($tripPlanId: String!, $input: InviteCollaboratorInput!) {
    inviteTripPlanCollaborator(tripPlanId: $tripPlanId, input: $input) { id }
  }
`;

export const GET_COLLABORATORS = `
  query Collaborators($tripPlanId: String!) {
    tripPlanCollaborators(tripPlanId: $tripPlanId) {
      id userId roleId
      role { id name }
      user { id firstName lastName email }
    }
  }
`;

export const REMOVE_COLLABORATOR = `
  mutation Remove($collaboratorId: String!) {
    removeTripPlanCollaborator(collaboratorId: $collaboratorId)
  }
`;

export const GET_SHARED_TRIP_PLANS = `
  query SharedPlans($limit: Int, $page: Int) {
    sharedTripPlans(limit: $limit, page: $page) {
      count
      items { id title startDate endDate }
    }
  }
`;

// --- Plans — Social ---

export const DELETE_COMMENT = `mutation Delete($id: String!) { deleteTripPlanItemComment(id: $id) }`;

export const CREATE_COMMENT = `
  mutation AddComment($itemId: String!, $input: CreateCommentInput!) {
    createTripPlanItemComment(itemId: $itemId, input: $input) { id text }
  }
`;

export const GET_COMMENTS = `
  query Comments($itemId: String!, $limit: Int) {
    tripPlanItemComments(itemId: $itemId, limit: $limit) {
      id text parentCommentId
      author { id firstName lastName }
      replies { id text author { firstName lastName } }
    }
  }
`;

export const REMOVE_VOTE = `mutation RemoveVote($itemId: String!) { deleteTripPlanItemFeedback(itemId: $itemId) }`;

export const CREATE_VOTE = `
  mutation CreateVote($itemId: String!, $input: CreateFeedbackInput!) {
    createTripPlanItemFeedback(itemId: $itemId, input: $input) { id }
  }
`;

export const UPDATE_VOTE = `
  mutation UpdateVote($itemId: String!, $feedbackType: FeedbackType!) {
    updateTripPlanItemFeedback(itemId: $itemId, feedbackType: $feedbackType) { id }
  }
`;

// --- Travellers ---

export const CREATE_TRAVELLER = `
  mutation CreateTraveller($tripPlanId: String!, $input: CreateTravellerInput!) {
    createTripPlanTraveller(tripPlanId: $tripPlanId, input: $input) {
      id firstName lastName email dateOfBirth gender declaredTravellerType
    }
  }
`;

export const CREATE_TRAVELLER_BRIEF = `
  mutation CreateTraveller($tripPlanId: String!, $input: CreateTravellerInput!) {
    createTripPlanTraveller(tripPlanId: $tripPlanId, input: $input) {
      id firstName lastName
    }
  }
`;

export const GET_TRAVELLERS = `
  query Travellers($tripPlanId: String!) {
    tripPlanTravellers(tripPlanId: $tripPlanId) {
      id firstName lastName email dateOfBirth gender declaredTravellerType
      passport { last4 issueCountry }
    }
  }
`;

export const GET_TRAVELLERS_BRIEF = `
  query Travellers($tripPlanId: String!) {
    tripPlanTravellers(tripPlanId: $tripPlanId) { id firstName lastName }
  }
`;

export const DELETE_TRAVELLER = `
  mutation DeleteTraveller($id: String!) {
    deleteTripPlanTraveller(id: $id)
  }
`;

export const UPDATE_TRAVELLER = `
  mutation UpdateTraveller($id: String!, $input: UpdateTravellerInput!) {
    updateTripPlanTraveller(id: $id, input: $input) {
      id firstName lastName email dateOfBirth gender declaredTravellerType
    }
  }
`;

// --- Search ---

export const GET_TRIP_PLAN_ITEM_TYPES = `query GetPlan($id: String!) { tripPlan(id: $id) { items { id title selection { type } } } }`;

export const CREATE_FLIGHT_SELECTION = `
  mutation CreateFlightSelection($tripPlanId: String!, $input: CreateFlightSelectionInput!) {
    createTripPlanFlightSelection(tripPlanId: $tripPlanId, input: $input) {
      item { id title tripPlanId }
      selection { id }
      options { id name price time airline duration bookingData sortOrder }
    }
  }
`;

export const CREATE_HOTEL_SELECTION = `
  mutation CreateHotelSelection($tripPlanId: String!, $input: CreateHotelSelectionInput!) {
    createTripPlanHotelSelection(tripPlanId: $tripPlanId, input: $input) {
      item { id title tripPlanId }
      selection { id }
      options { id name price time duration bookingData sortOrder }
    }
  }
`;

export const CREATE_ACTIVITY_SELECTION = `
  mutation CreateActivitySelection($tripPlanId: String!, $input: CreateActivitySelectionInput!) {
    createTripPlanActivitySelection(tripPlanId: $tripPlanId, input: $input) {
      item { id title tripPlanId }
      selection { id }
      options { id name price time duration bookingData sortOrder }
    }
  }
`;

// --- Select ---

export const SELECT_DEPARTURE_FLIGHT = `
  mutation SelectDeparture($selectionId: String!, $flightToken: String!) {
    selectDepartureFlight(selectionId: $selectionId, flightToken: $flightToken) {
      id
      options { id name price time airline duration bookingData }
    }
  }
`;

export const SELECT_RETURN_FLIGHT = `
  mutation SelectReturn($selectionId: String!, $flightToken: String!) {
    selectReturnFlight(selectionId: $selectionId, flightToken: $flightToken) {
      id
      options { id name price time airline duration bookingData }
    }
  }
`;

export const SET_TRIP_PLAN_SELECTED_OPTION = `
  mutation SetSelected($selectionId: String!, $optionId: String!) {
    setTripPlanSelectedOption(selectionId: $selectionId, optionId: $optionId) {
      id
      selectedOption { id name price }
    }
  }
`;

// --- Bookings ---

export const GET_BOOKING_RECORDS = `
  query GetBookingRecords($filters: BookingRecordFiltersInput) {
    getBookingRecords(filters: $filters) {
      id type status pnr providerName providerReference amount currency
      issueDate travelStartDate travelEndDate tripPlanId
      tripPlan { id title }
      tripPlanItem { id title }
    }
  }
`;

export const GET_BOOKING_RECORDS_BY_USER = `{ getBookingRecordsByUser {
    id type status pnr providerName providerReference amount currency
    issueDate travelStartDate travelEndDate tripPlanId
    tripPlan { id title }
    tripPlanItem { id title }
  } }`;

export const REFRESH_BOOKING_RECORD = `
  mutation Refresh($id: String!) {
    refreshBookingRecord(id: $id) { id status }
  }
`;

export const GET_BOOKING_RECORD = `
  query GetBookingRecord($id: String!) {
    getBookingRecord(id: $id) {
      id type status pnr providerName providerReference amount currency
      issueDate travelStartDate travelEndDate tripPlanId
      tripPlan { id title }
      tripPlanItem { id title }
      travellers { firstName lastName }
    }
  }
`;

// --- Chat ---

export const CREATE_CHAT_SESSION = `
  mutation CreateChatSession($input: CreateSessionInput) {
    createChatSession(input: $input) {
      id
      title
    }
  }
`;

export const LIST_CHAT_SESSIONS = `
  query ChatSessions($page: Int, $limit: Int) {
    chatSessions(page: $page, limit: $limit) {
      items {
        id
        title
        updatedAt
      }
      count
      page
    }
  }
`;

// --- Clients (v2.0.0 — TripPlanClient surface) ---

export const LIST_TRIP_PLAN_CLIENTS = `
  query TripPlanClients {
    tripPlanClients {
      id
      name
      email
      phone
      avatarUrl
      description
      clientType
      status
      createdAt
      updatedAt
    }
  }
`;

export const GET_TRIP_PLAN_CLIENT = `
  query TripPlanClient($id: String!) {
    tripPlanClient(id: $id) {
      id
      name
      email
      phone
      avatarUrl
      description
      clientType
      status
      createdAt
      updatedAt
    }
  }
`;

export const CREATE_TRIP_PLAN_CLIENT = `
  mutation CreateTripPlanClient($input: CreateTripPlanClientInput!) {
    createTripPlanClient(input: $input) {
      id
      name
      email
      phone
      avatarUrl
      description
      clientType
      status
      createdAt
      updatedAt
    }
  }
`;

export const UPDATE_TRIP_PLAN_CLIENT = `
  mutation UpdateTripPlanClient($id: String!, $input: UpdateTripPlanClientInput!) {
    updateTripPlanClient(id: $id, input: $input) {
      id
      name
      email
      phone
      avatarUrl
      description
      clientType
      status
      createdAt
      updatedAt
    }
  }
`;

// --- Doctor (v2.0.0 — used for self-checks) ---

export const DOCTOR_PING = `
  query DoctorPing {
    __schema { queryType { name } }
  }
`;
