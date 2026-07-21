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
        metadata
      }
      itemCount
      total
      currency
    }
  }
`;

/**
 * v2 cart-with-bookability query.
 *
 * Pulls the cart and a parallel "bookability map" derived from each goal's items'
 * selections' options in a single round-trip. Workaround until the API exposes
 * `tripPlanCartWithBookability` (P1 Mark sync question, PHASE2-DESIGN-FREEZE.md §3).
 *
 * Use over GET_CART whenever you need per-item bookability or by-goal grouping.
 */
export const GET_CART_V2 = `
  query TripPlanCartV2($id: String!) {
    tripPlan(id: $id) {
      id
      title
      cart {
        items {
          id
          name
          description
          price
          currency
          type
          selectionId
          optionId
          metadata
        }
        itemCount
        total
        currency
      }
      goals {
        id
        name
        sortOrder
        items {
          id
          title
          goalId
          selections {
            id
            type
            isLocked
            options {
              id
              name
              isBookable
              status
              blueprintListingId
              externalId
            }
          }
        }
      }
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
        type
        selections {
          id
          type
          isLocked
          parentOptionId
          travellerOptionChoices {
            traveller { id }
            selectedOption { id }
          }
          assignedTravellers {
            id
            firstName
            lastName
            dateOfBirth
            gender
          }
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
            sourceOptionId
            childSelections {
              id
              type
              isLocked
              parentOptionId
              travellerOptionChoices {
                traveller { id }
                selectedOption { id }
              }
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
      hostedInvoiceUrl
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

// NOTE: setTripPlanSubSelectionOption + refreshTripPlanSubSelectionOptions were
// DELETED from the schema in the Goals/Blueprint architecture migration. The
// "sub-selection" model is gone; child selections are now ordinary selections
// reached via childSelections[] and chosen via setTripPlanSelectedOption.
// (Removed in VOY-1414. Polling lives in `selection-options` / VOY-1415.)

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

// NOTE: TripPlanItem.{date,startTime,endTime,day} columns were dropped in API PR #386
// (itinerary timing now lives on the tripPlanEvents resolver). TripPlanItem.selection
// (singular, with a single `selectedOption`) was replaced by selections (plural array),
// where each TripPlanSelection has a list of candidate `options` and the chosen one is
// identified by `parentOptionId` (matching options[].id), or null when nothing is
// selected yet. There is no `selectedOption` field on TripPlanSelection.
// Shape verified against the live dev schema and GET_PLAN_DEEP. VOY-1407 was a prod
// outage caused by this drift — keep these queries aligned to the live schema.
// Selections carry travellerOptionChoices (participant-choice model) — chosen
// state derives from consensus; parentOptionId is a legacy fallback (VOY-1701).
const PLAN_SELECTION_FIELDS = `selections { id type isLocked parentOptionId travellerOptionChoices { traveller { id } selectedOption { id } } options { id name price status } }`;

export const GET_TRIP_PLAN = `
  query TripPlan($id: String!) {
    tripPlan(id: $id) {
      id title description startDate endDate
      items {
        id type title
        ${PLAN_SELECTION_FIELDS}
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
        id type title
        ${PLAN_SELECTION_FIELDS}
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

/**
 * VOY-1704 `plan-status`: ONE round trip answering "what's left before this
 * plan can book?". Two root fields share $id: tripPlan (title, travellers'
 * checkout fields, cart) + tripPlanGoals (readiness, deep selections with
 * travellerOptionChoices/inputs/options for consensus + blockedOn derivation).
 */
export const GET_PLAN_STATUS = `
  query PlanStatus($id: String!) {
    tripPlan(id: $id) {
      id
      title
      travellers {
        id firstName lastName dateOfBirth gender
        passport { last4 }
      }
      cart {
        itemCount
        total
        currency
        items { selectionId optionId requiresPassport }
      }
    }
    tripPlanGoals(tripPlanId: $id) {
      id
      name
      type
      sortOrder
      isDecided
      isBooked
      checkoutReadiness {
        isReady
        requirements {
          label
          isFulfilled
          isRequired
          selectionId
          type
          missingTravellerIds
        }
      }
      items {
        id
        title
        selections {
          id
          type
          mode
          isComplete
          isLocked
          blueprintMonitorId
          parentOptionId
          travellerOptionChoices {
            traveller { id }
            selectedOption { id }
          }
          inputs { id fieldName fieldLabel isRequired value sourceOutputId }
          options { id name isBookable }
        }
      }
    }
  }
`;

// --- Travellers ---

export const CREATE_TRAVELLER = `
  mutation CreateTraveller($tripPlanId: String!, $input: CreateTripPlanTravellerInput!) {
    createTripPlanTraveller(tripPlanId: $tripPlanId, input: $input) {
      id firstName lastName email dateOfBirth gender declaredTravellerType
    }
  }
`;

export const CREATE_TRAVELLER_BRIEF = `
  mutation CreateTraveller($tripPlanId: String!, $input: CreateTripPlanTravellerInput!) {
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

// NOTE: input type renamed UpdateTravellerInput -> UpdateTripPlanTravellerInput
// in the July-2026 traveller requirements work (VOY-1395 era). Load-bearing:
// gender + dateOfBirth are REQUIRED for flight checkout (TSA Secure Flight),
// and passport data hard-gates international reserves. (VOY-1692)
export const UPDATE_TRAVELLER = `
  mutation UpdateTraveller($id: String!, $input: UpdateTripPlanTravellerInput!) {
    updateTripPlanTraveller(id: $id, input: $input) {
      id firstName lastName email dateOfBirth gender declaredTravellerType
    }
  }
`;

// --- Search ---

export const GET_TRIP_PLAN_ITEM_TYPES = `query GetPlan($id: String!) { tripPlan(id: $id) { items { id title selections { type } } } }`;

export const CREATE_FLIGHT_SELECTION = `
  mutation CreateFlightSelection($tripPlanId: String!, $input: CreateFlightSelectionInput!) {
    createTripPlanFlightSelection(tripPlanId: $tripPlanId, input: $input) {
      item { id title tripPlanId }
      selection { id }
      options { id name price time airline duration bookingData: optionData sortOrder }
    }
  }
`;

export const CREATE_HOTEL_SELECTION = `
  mutation CreateHotelSelection($tripPlanId: String!, $input: CreateHotelSelectionInput!) {
    createTripPlanHotelSelection(tripPlanId: $tripPlanId, input: $input) {
      item { id title tripPlanId }
      selection { id }
      options { id name price time duration bookingData: optionData sortOrder }
    }
  }
`;

export const CREATE_ACTIVITY_SELECTION = `
  mutation CreateActivitySelection($tripPlanId: String!, $input: CreateActivitySelectionInput!) {
    createTripPlanActivitySelection(tripPlanId: $tripPlanId, input: $input) {
      item { id title tripPlanId }
      selection { id }
      options { id name price time duration bookingData: optionData sortOrder }
    }
  }
`;

// Lean goals+selections read for resolving a goal and its mirror *List
// selection in the search/create flow (VOY-1414).
export const GET_GOALS_FOR_SEARCH = `
  query GoalsForSearch($tripPlanId: String!) {
    tripPlanGoals(tripPlanId: $tripPlanId) {
      id
      name
      type
      sortOrder
      items {
        selections { id type segmentIndex }
      }
    }
  }
`;

// --- Search inputs (goal/mirror-list model, VOY-1414) ---
// In the new model, create*Selection only links a selection to a goal's mirror
// *List; the search PARAMS (origin/dest/dates) are set on the goal's Airport /
// Date selections, which feed the list's monitor. These set those inputs.

export const UPDATE_AIRPORT_SELECTION = `
  mutation UpdateAirportSelection($selectionId: String!, $input: UpdateAirportSelectionInput!) {
    updateTripPlanAirportSelection(selectionId: $selectionId, input: $input) {
      id
      type
    }
  }
`;

export const CREATE_AIRPORT_SELECTION = `
  mutation CreateAirportSelection($tripPlanId: String!, $input: CreateAirportSelectionInput!) {
    createTripPlanAirportSelection(tripPlanId: $tripPlanId, input: $input) {
      selection { id }
    }
  }
`;

export const CREATE_DATE_SELECTION = `
  mutation CreateDateSelection($tripPlanId: String!, $input: CreateDateSelectionInput!) {
    createTripPlanDateSelection(tripPlanId: $tripPlanId, input: $input) {
      selection { id }
    }
  }
`;

export const ADD_DATE_OPTION = `
  mutation AddTripPlanDateOption($selectionId: String!, $startDate: String!) {
    addTripPlanDateOption(selectionId: $selectionId, startDate: $startDate) {
      id
    }
  }
`;

// addTripPlanDateOption only populates the Date selection's startDate output.
// To resolve a date RANGE (so the endDate output — and thus the return-leg /
// hotel check-out bindings — become non-null), set the Date selection's
// `duration` input: endDate = startDate + duration days. Without this the
// flight/hotel monitor query stays "insufficient" and never fetches inventory
// (VOY-1421).
export const SET_SELECTION_INPUT_VALUE = `
  mutation SetTripPlanSelectionInputValue($selectionId: String!, $fieldName: String!, $value: JSON!) {
    setTripPlanSelectionInputValue(selectionId: $selectionId, fieldName: $fieldName, value: $value) {
      id
    }
  }
`;

// Location/destination lives on the plan-level Destination selection (a shared
// Destination goal), NOT per Hotel/Activity goal. setTripPlanDestinationValue
// applies a freeform place name so the --location/--destination flag takes effect.
export const SET_DESTINATION_VALUE = `
  mutation SetTripPlanDestinationValue($selectionId: String!, $name: String!) {
    setTripPlanDestinationValue(selectionId: $selectionId, name: $name) {
      id
      type
    }
  }
`;

// --- Select ---

// NOTE: selectDepartureFlight + selectReturnFlight were DELETED from the schema
// in the Goals/Blueprint migration. Round-trip is no longer a two-phase
// token dance — each leg/journey is an ordinary selection whose chosen option is
// set via setTripPlanSelectedOption. (Removed in VOY-1414.)

// The default "choose an option" verb. Since the participant-choice migration
// (July 2026, "passing legs"), setTripPlanSelectedOption is a server-side ALIAS
// for setTravellerChoiceForAll: it records the same choice for every assigned
// traveller. It REJECTS list-mode selections ("Cannot set traveller choices on
// a list-mode selection") — picks happen on the goal's single decision
// selection, whose options resolve from its mirrored list. The option must
// belong to the selection itself or its DIRECT mirrorListSelectionId (the
// backend validates exactly one mirror hop). (VOY-1692)
export const SET_TRIP_PLAN_SELECTED_OPTION = `
  mutation SetSelected($selectionId: String!, $optionId: String!) {
    setTripPlanSelectedOption(selectionId: $selectionId, optionId: $optionId) {
      id
      parentOptionId
      parentOption { id name price }
    }
  }
`;

// --- Participant-choice scopes (VOY-1692) ---
// The webapp's traveller-choice mutation family. Same 1-mirror-hop option
// validation as setTripPlanSelectedOption. All return the updated selection.

export const SET_TRAVELLER_CHOICE_FOR_SUBSET = `
  mutation SetChoiceForSubset($selectionId: String!, $travellerIds: [String!]!, $optionId: String!, $replaceExisting: Boolean!) {
    setTripPlanTravellerChoiceForSubset(selectionId: $selectionId, travellerIds: $travellerIds, optionId: $optionId, replaceExisting: $replaceExisting) {
      id
      parentOptionId
      parentOption { id name price }
    }
  }
`;

export const SET_TRAVELLER_CHOICE_FOR_GROUP = `
  mutation SetChoiceForGroup($selectionId: String!, $groupId: String!, $optionId: String!) {
    setTripPlanTravellerChoiceForGroup(selectionId: $selectionId, groupId: $groupId, optionId: $optionId) {
      id
      parentOptionId
      parentOption { id name price }
    }
  }
`;

export const SET_SELECTION_TRAVELLER_CHOICE = `
  mutation SetChoiceForTraveller($selectionId: String!, $travellerId: String!, $optionId: String!) {
    setTripPlanSelectionTravellerChoice(selectionId: $selectionId, travellerId: $travellerId, optionId: $optionId) {
      id
      parentOptionId
      parentOption { id name price }
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
  query TripPlanClients($page: Int!, $limit: Int!) {
    tripPlanClients(page: $page, limit: $limit) {
      count
      page
      limit
      items {
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
      count
      page
      limit
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

// --- Itinerary (v2.0.0 — computed from selections via tripPlanEvents resolver) ---
//
// Per Phase 0 audit: `tripPlanEvents` is FROZEN. Fields exposed at top level:
//   name, datetime, localTime, duration, description, location { name, address, placeId, metadata }, metadata
//
// Note: `eventType` and `selectionId` are NOT direct fields. They may live in `metadata: JSON`.
// (Open question logged for Mark sync as P3.)

export const GET_TRIP_PLAN_EVENTS = `
  query TripPlanEvents($id: String!) {
    tripPlan(id: $id) {
      id
      title
      startDate
      endDate
      tripPlanEvents {
        name
        datetime
        localTime
        duration
        description
        metadata
        location {
          name
          address
          placeId
          metadata
        }
      }
    }
  }
`;

// --- Listings (v2.0.0 — Section 7, Blueprint Listings surface) ---

export const GET_BLUEPRINT_LISTING_CHANGE_EVENTS = `
  query BlueprintListingChangeEvents($blueprintMonitorId: String!, $limit: Int) {
    blueprintListingChangeEvents(blueprintMonitorId: $blueprintMonitorId, limit: $limit) {
      id
      blueprintListingId
      blueprintMonitorId
      listingName
      changeType
      details
      blueprintListing {
        id
        name
        price
        isAvailable
        isBookable
      }
    }
  }
`;

export const GET_BLUEPRINT_LISTING_CHANGE_EVENTS_BY_TYPE = `
  query BlueprintListingChangeEventsByType($blueprintMonitorId: String!, $changeType: ListingChangeType!, $limit: Int) {
    blueprintListingChangeEventsByType(blueprintMonitorId: $blueprintMonitorId, changeType: $changeType, limit: $limit) {
      id
      blueprintListingId
      blueprintMonitorId
      listingName
      changeType
      details
      blueprintListing {
        id
        name
        price
        isAvailable
        isBookable
      }
    }
  }
`;

export const ADD_BLUEPRINT_LISTING_AS_SELECTION_OPTION = `
  mutation AddBlueprintListingAsSelectionOption($listingId: String!, $selectionId: String!) {
    addBlueprintListingAsSelectionOption(listingId: $listingId, selectionId: $selectionId) {
      id
      name
      price
      isBookable
      status
    }
  }
`;

/**
 * All concrete members of TripPlanSelectionUnion (live schema, 2026-06-02).
 * getTripPlanSelection returns this union and union members share no interface,
 * so a shape-agnostic query must spread the same field set across every member.
 * Building the query from this list (rather than hand-writing 31 fragments)
 * keeps it DRY and means a newly-added selection type is one edit here.
 * `doctor` (VOY-1411) validates the resulting query string against the live
 * schema, so a stale member name surfaces immediately.
 */
export const TRIP_PLAN_SELECTION_UNION_MEMBERS = [
  "TripPlanActivityListSelection",
  "TripPlanActivityOptionListSelection",
  "TripPlanActivityOptionSelection",
  "TripPlanActivitySelection",
  "TripPlanAirportSelection",
  "TripPlanCurrencySelection",
  "TripPlanDateSelection",
  "TripPlanDestinationSelection",
  "TripPlanDurationSelection",
  "TripPlanFlightClassListSelection",
  "TripPlanFlightClassSelection",
  "TripPlanFlightJourneyListSelection",
  "TripPlanFlightJourneySelection",
  "TripPlanFlightListSelection",
  "TripPlanFlightSelection",
  "TripPlanHotelListSelection",
  "TripPlanHotelRoomListSelection",
  "TripPlanHotelRoomSelection",
  "TripPlanHotelSelection",
  "TripPlanLocationListSelection",
  "TripPlanLocationSelection",
  "TripPlanPassportSelection",
  "TripPlanRestaurantListSelection",
  "TripPlanRestaurantReservationSelection",
  "TripPlanRestaurantSelection",
  "TripPlanRideSelection",
  "TripPlanRoomArrangementSelection",
  "TripPlanSelection",
  "TripPlanTimeListSelection",
  "TripPlanTimeSelection",
  "TripPlanTravellerListSelection",
] as const;

const SELECTION_MONITOR_FIELDS = `
        id
        tripPlanId
        type
        blueprintMonitorId
        parentOptionId
        travellerOptionChoices {
          traveller { id firstName lastName }
          selectedOption { id }
          scope
        }
        inputs {
          id
          fieldName
          fieldLabel
          isRequired
          value
          sourceOutputId
        }
        options {
          id
          name
          price
          time
          airline
          duration
          sortOrder
        }`;

/**
 * Shape-agnostic: works for ANY selection type via the union. Returns the
 * selection's options + its monitor id. Combined with GET_BLUEPRINT_MONITOR
 * (by blueprintMonitorId) this drives the `options --wait` status taxonomy.
 * The CLI never recomputes sufficiency — it reports what the backend exposes.
 *
 * (Fixes VOY-1419 arg drift: getTripPlanHotelSelection(id) was hotel-only and
 * the wrong arg name; getTripPlanSelection(tripPlanSelectionId) is generic.)
 */
export const GET_SELECTION_WITH_MONITOR = `
  query TripPlanSelectionWithMonitor($tripPlanSelectionId: String!) {
    getTripPlanSelection(tripPlanSelectionId: $tripPlanSelectionId) {
      __typename
${TRIP_PLAN_SELECTION_UNION_MEMBERS.map(
    (m) => `      ... on ${m} {${SELECTION_MONITOR_FIELDS}
      }`,
  ).join("\n")}
    }
  }
`;

/**
 * Read an EXISTING decision selection's id + options for the search reuse path
 * (VOY-1692). The skeleton goal graph already carries the decision selection
 * (for flights: the leg selection, re-mirrored onto the FlightJourney by the
 * backend's createJourneyForLegs — the only wiring whose options resolve AND
 * whose picks validate, since both are 1-mirror-hop). Search must REUSE it,
 * never create a parallel selection mirroring the *List (that lands 2 hops
 * from the option rows: options read empty and every pick is rejected).
 */
const DECISION_OPTION_FIELDS = `
        id
        options { id name price time airline duration bookingData: optionData sortOrder }`;

export const GET_DECISION_SELECTION_OPTIONS = `
  query DecisionSelectionOptions($tripPlanSelectionId: String!) {
    getTripPlanSelection(tripPlanSelectionId: $tripPlanSelectionId) {
      __typename
      ... on TripPlanFlightSelection {${DECISION_OPTION_FIELDS}
      }
      ... on TripPlanHotelSelection {${DECISION_OPTION_FIELDS}
      }
      ... on TripPlanActivitySelection {${DECISION_OPTION_FIELDS}
      }
    }
  }
`;

/**
 * Monitor fetch-state, read by selection's blueprintMonitorId. Drives the
 * FETCHING / NO_RESULTS / FETCH_ERROR distinction in `options --wait`.
 */
export const GET_BLUEPRINT_MONITOR = `
  query BlueprintMonitor($id: String!) {
    blueprintMonitor(id: $id) {
      id
      type
      queryVersion
      fetchedAt
      lastFetchAttempt
      lastFetchError
    }
  }
`;

/**
 * Refresh a selection's options (enqueues a BlueprintMonitor fetch). No-op on
 * the backend if the selection has no monitor / is not auto-fetchable.
 */
export const REFRESH_SELECTION_OPTIONS = `
  mutation RefreshTripPlanSelectionOptions($selectionId: String!) {
    refreshTripPlanSelectionOptions(selectionId: $selectionId)
  }
`;

// --- Places (v2.0.0 — Section 7, geo/place surface) ---

export const SEARCH_PLACES = `
  query SearchPlaces($query: String, $countryId: String, $localityId: String, $location: SearchLocationInput, $type: String, $limit: Int, $page: Int, $hasTrips: Boolean) {
    searchPlaces(query: $query, countryId: $countryId, localityId: $localityId, location: $location, type: $type, limit: $limit, page: $page, hasTrips: $hasTrips) {
      items {
        id
        name
        description
        location {
          latitude
          longitude
        }
        address {
          street
          city
          state
          postalCode
          country
        }
        country {
          id
          name
        }
        locality {
          id
          name
        }
      }
      count
      page
      limit
    }
  }
`;

export const SEARCH_EXTERNAL_PLACES = `
  query SearchExternalPlaces($query: String!, $countryCode: String, $location: SearchLocationInput) {
    searchExternalPlaces(query: $query, countryCode: $countryCode, location: $location) {
      id
      name
      description
      location {
        latitude
        longitude
      }
      address {
        street
        city
        state
        postalCode
        country
      }
      country {
        id
        name
      }
      locality {
        id
        name
      }
    }
  }
`;

export const GET_PLACE_BY_ID = `
  query GetPlaceById($id: String!) {
    getPlaceById(id: $id) {
      id
      name
      description
      location {
        latitude
        longitude
      }
      address {
        street
        city
        state
        postalCode
        country
      }
      country {
        id
        name
      }
      locality {
        id
        name
      }
    }
  }
`;

export const GET_PLACE_BY_EXTERNAL_ID = `
  query GetPlaceByExternalId($externalId: String!) {
    getPlaceByExternalId(externalId: $externalId) {
      id
      name
      description
      location {
        latitude
        longitude
      }
      address {
        street
        city
        state
        postalCode
        country
      }
      country {
        id
        name
      }
      locality {
        id
        name
      }
    }
  }
`;

export const GET_TRIP_PLAN_PLACES = `
  query GetTripPlanPlaces($tripPlanId: String!) {
    getTripPlanPlaces(tripPlanId: $tripPlanId) {
      id
      name
      placeId
      tripPlanId
      type
      types
      countryId
      countryName
      description
      iataCode
      image
      url
      placeTimezone
      location {
        latitude
        longitude
      }
    }
  }
`;

// GET_TRIP_PLAN_PLACE was defined in the initial Section 7 draft but never
// wired to a command surface. Removed to keep queries.ts honest — reintroduce
// when a `places get-attached <id>` (or similar) command is added.

export const GET_HIGHLIGHTED_TRIP_PLACES = `
  query HighlightedTripPlaces($tripId: String!, $category: HighlightedPlaceCategory!) {
    highlightedTripPlaces(tripId: $tripId, category: $category) {
      id
      ranking
      category
      detectedPlace {
        id
        name
        placeId
        location {
          latitude
          longitude
        }
      }
    }
  }
`;

export const UPSERT_TRIP_PLAN_PLACE = `
  mutation UpsertTripPlanPlace($input: UpsertTripPlanPlaceInput!) {
    upsertTripPlanPlace(input: $input) {
      id
      name
      placeId
      tripPlanId
      type
      types
      countryId
      countryName
      description
      iataCode
      image
      url
      placeTimezone
      location {
        latitude
        longitude
      }
    }
  }
`;

export const REMOVE_TRIP_PLAN_PLACE = `
  mutation RemoveTripPlanPlace($id: String!) {
    removeTripPlanPlace(id: $id)
  }
`;

export const HIGHLIGHT_TRIP_PLACE = `
  mutation HighlightTripPlace($tripId: String!, $detectedPlaceId: String!, $category: HighlightedPlaceCategory!, $ranking: Int) {
    highlightTripPlace(tripId: $tripId, detectedPlaceId: $detectedPlaceId, category: $category, ranking: $ranking) {
      id
      ranking
      category
      detectedPlace {
        id
        name
        placeId
      }
    }
  }
`;

export const UNHIGHLIGHT_TRIP_PLACE = `
  mutation UnhighlightTripPlace($tripId: String!, $detectedPlaceId: String!) {
    unhighlightTripPlace(tripId: $tripId, detectedPlaceId: $detectedPlaceId)
  }
`;

// --- Goals (v2.0.0 — Section 4 — TripPlanGoal surface) ---
//
// Mark confirmed 2026-05-04 (Slack DM ts 1777910418): TripPlanGoal mutations
// are FROZEN. Build CLI commands without --experimental gate.
//
// Schema corrections caught during planning (PHASE2-DESIGN-FREEZE.md draft):
//   - No `goalReorder` mutation; CLI synthesizes via parallel updateTripPlanGoal calls.
//   - createTripPlanGoalWithSelection uses placeBeforeGoalId/placeAfterGoalId
//     for positional inserts (separate from sortOrder on the bare-create path).
//   - assignTravellersToGoal is a separate post-create mutation.
//   - addItemWithSelectionToGoal returns { item, selection }, not Boolean.
//   - addConstraintToGoal exists but is web-UI-only for v2.0.0-alpha (deferred).

export const LIST_TRIP_PLAN_GOALS = `
  query TripPlanGoals($tripPlanId: String!) {
    tripPlanGoals(tripPlanId: $tripPlanId) {
      id
      name
      type
      scope
      sortOrder
      relativeDay
      date
      isDecided
      isBooked
      checkoutReadiness {
        isReady
        requirements {
          label
          isFulfilled
          isRequired
          selectionId
          type
          missingTravellerIds
        }
      }
      includeAllTravellers
      groupName
      primaryItemId
    }
  }
`;

export const LIST_TRIP_PLAN_GOALS_DEEP = `
  query TripPlanGoalsDeep($tripPlanId: String!) {
    tripPlanGoals(tripPlanId: $tripPlanId) {
      id
      name
      type
      scope
      sortOrder
      relativeDay
      date
      isDecided
      isBooked
      checkoutReadiness {
        isReady
        requirements {
          label
          isFulfilled
          isRequired
          selectionId
          type
          missingTravellerIds
        }
      }
      includeAllTravellers
      groupName
      primaryItemId
      items {
        id
        title
        goalId
        selections {
          id
          type
          isLocked
        }
      }
      travellers {
        id
        firstName
        lastName
      }
    }
  }
`;

export const GET_TRIP_PLAN_GOAL = `
  query TripPlanGoal($id: String!) {
    tripPlanGoal(id: $id) {
      id
      name
      type
      scope
      sortOrder
      relativeDay
      date
      isDecided
      isBooked
      checkoutReadiness {
        isReady
        requirements {
          label
          isFulfilled
          isRequired
          selectionId
          type
          missingTravellerIds
        }
      }
      includeAllTravellers
      groupName
      primaryItemId
      tripPlanId
      travellers {
        id
        firstName
        lastName
      }
      items {
        id
        title
        goalId
        selections {
          id
          type
          isLocked
        }
      }
    }
  }
`;

export const CREATE_TRIP_PLAN_GOAL = `
  mutation CreateTripPlanGoal($input: CreateTripPlanGoalInput!) {
    createTripPlanGoal(input: $input) {
      id
      name
      type
      scope
      sortOrder
      relativeDay
      date
      isDecided
      isBooked
      includeAllTravellers
      groupName
      primaryItemId
      tripPlanId
    }
  }
`;

export const CREATE_TRIP_PLAN_GOAL_WITH_SELECTION = `
  mutation CreateTripPlanGoalWithSelection($input: CreateGoalWithSelectionInput!) {
    createTripPlanGoalWithSelection(input: $input) {
      goal {
        id
        name
        type
        scope
        sortOrder
        relativeDay
        date
        isDecided
        isBooked
        includeAllTravellers
        groupName
        primaryItemId
        tripPlanId
      }
      item {
        id
        title
        goalId
      }
      selection {
        id
        type
        isLocked
      }
    }
  }
`;

export const UPDATE_TRIP_PLAN_GOAL = `
  mutation UpdateTripPlanGoal($id: String!, $input: UpdateTripPlanGoalInput!) {
    updateTripPlanGoal(id: $id, input: $input) {
      id
      name
      type
      scope
      sortOrder
      relativeDay
      date
      isDecided
      isBooked
      tripPlanId
    }
  }
`;

export const DELETE_TRIP_PLAN_GOAL = `
  mutation DeleteTripPlanGoal($id: String!) {
    deleteTripPlanGoal(id: $id)
  }
`;

export const ADD_ITEM_TO_GOAL = `
  mutation AddItemToGoal($goalId: String!, $itemId: String!) {
    addItemToGoal(goalId: $goalId, itemId: $itemId)
  }
`;

export const ADD_ITEM_WITH_SELECTION_TO_GOAL = `
  mutation AddItemWithSelectionToGoal($goalId: String!, $tripPlanId: String!, $type: SelectionType!) {
    addItemWithSelectionToGoal(goalId: $goalId, tripPlanId: $tripPlanId, type: $type) {
      item {
        id
        title
        goalId
      }
      selection {
        id
        type
        isLocked
      }
    }
  }
`;

export const ASSIGN_TRAVELLERS_TO_GOAL = `
  mutation AssignTravellersToGoal($goalId: String!, $travellerIds: [String!]!) {
    assignTravellersToGoal(goalId: $goalId, travellerIds: $travellerIds)
  }
`;

// --- Traveller Groups (v2.1.0 — Section 6) ---
//
// Schema-verified from introspection 2026-05-04.
// TripPlanTravellerGroup fields: id, name, color (nullable), sortOrder, tripPlanId, tripPlan, travellers
// CreateTripPlanTravellerGroupInput: name (required), color, travellerIds
// UpdateTripPlanTravellerGroupInput: name, color, sortOrder (color/sortOrder NOT exposed as CLI inputs per audit)

const TRAVELLER_GROUP_FIELDS = `
  id
  name
  color
  sortOrder
  tripPlanId
  tripPlan { id title travellers { id } }
  travellers { id firstName lastName email }
`;

export const LIST_TRIP_PLAN_TRAVELLER_GROUPS = `
  query TripPlanTravellerGroups($tripPlanId: String!) {
    tripPlanTravellerGroups(tripPlanId: $tripPlanId) {
      id name color sortOrder
      travellers { id firstName lastName email }
    }
    tripPlan(id: $tripPlanId) { id title travellers { id } }
  }
`;

export const GET_TRIP_PLAN_TRAVELLER_GROUP = `
  query TripPlanTravellerGroup($id: String!) {
    tripPlanTravellerGroup(id: $id) { ${TRAVELLER_GROUP_FIELDS} }
  }
`;

export const CREATE_TRIP_PLAN_TRAVELLER_GROUP = `
  mutation CreateTripPlanTravellerGroup($input: CreateTripPlanTravellerGroupInput!, $tripPlanId: String!) {
    createTripPlanTravellerGroup(input: $input, tripPlanId: $tripPlanId) { ${TRAVELLER_GROUP_FIELDS} }
  }
`;

export const UPDATE_TRIP_PLAN_TRAVELLER_GROUP = `
  mutation UpdateTripPlanTravellerGroup($id: String!, $input: UpdateTripPlanTravellerGroupInput!) {
    updateTripPlanTravellerGroup(id: $id, input: $input) { ${TRAVELLER_GROUP_FIELDS} }
  }
`;

export const DELETE_TRIP_PLAN_TRAVELLER_GROUP = `
  mutation DeleteTripPlanTravellerGroup($id: String!) {
    deleteTripPlanTravellerGroup(id: $id)
  }
`;

export const ADD_TRAVELLERS_TO_GROUP = `
  mutation AddTravellersToGroup($groupId: String!, $travellerIds: [String!]!) {
    addTravellersToGroup(groupId: $groupId, travellerIds: $travellerIds) { ${TRAVELLER_GROUP_FIELDS} }
  }
`;

export const REMOVE_TRAVELLERS_FROM_GROUP = `
  mutation RemoveTravellersFromGroup($groupId: String!, $travellerIds: [String!]!) {
    removeTravellersFromGroup(groupId: $groupId, travellerIds: $travellerIds) { ${TRAVELLER_GROUP_FIELDS} }
  }
`;

// --- Traveller Choices (v2.1.0 — Section 6) ---
//
// travellerChoices returns TravellerChoicesResult! (non-null per introspection).
// TripPlanSelectOption uses `name` not `label`.
// TripPlanSelectionInput fields: id, fieldName, fieldLabel, isRequired.

export const GET_TRAVELLER_CHOICES = `
  query TravellerChoices($tripPlanId: String!) {
    travellerChoices(tripPlanId: $tripPlanId) {
      title
      startDate
      endDate
      numberOfDays
      numberOfNights
      travellers { id firstName lastName }
      questions {
        selectionId
        selectionType
        title
        goalId
        groupName
        questionTemplate
        options { id name isBookable }
        inputs { id fieldName fieldLabel isRequired }
        answeredTravellers { id firstName lastName }
        pendingTravellers { id firstName lastName }
      }
    }
  }
`;

// --- Send to client + Quote (VOY-1212) ---

export const SEND_TRIP_PLAN_TO_CLIENT = `
  mutation SendTripPlanToClient($tripPlanId: String!, $input: SendToClientInput) {
    sendTripPlanToClient(tripPlanId: $tripPlanId, input: $input) {
      id
      email
      status
      invitedUserId
      expiresAt
    }
  }
`;
// NB: TripPlanUserInvite.createdAt is NOT exposed on prod GraphQL (live-verified
// 2026-07-20) even though the entity decorates it — do not add it back.

// Quote = GET_CART_V2's cart+goals walk (bookability join) + the client/date
// metadata a client-facing offer needs. Kept as its own query so quote and
// book can evolve their selections independently. Cart items trimmed to what
// quote renders — no description/metadata (metadata can be large; quote is a
// read-only snapshot, keep it light).
export const GET_QUOTE_DATA = `
  query TripPlanQuote($id: String!) {
    tripPlan(id: $id) {
      id
      title
      startDate
      endDate
      client { id name email phone }
      cart {
        items {
          id
          name
          price
          currency
          type
          selectionId
          optionId
        }
        itemCount
        total
        currency
      }
      goals {
        id
        name
        sortOrder
        items {
          id
          title
          goalId
          selections {
            id
            type
            isLocked
            options {
              id
              name
              isBookable
              status
              blueprintListingId
              externalId
            }
          }
        }
      }
    }
  }
`;

// Lightweight client-email pre-check for `send` — lets the confirm rail show
// the real recipient (and fail fast with a fix hint) BEFORE the mutation.
export const GET_PLAN_CLIENT = `
  query TripPlanClientCheck($id: String!) {
    tripPlan(id: $id) {
      id
      title
      client { id name email }
    }
  }
`;
