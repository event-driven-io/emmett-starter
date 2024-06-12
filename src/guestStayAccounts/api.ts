import {
  CommandHandler,
  assertNotEmptyString,
  assertPositiveNumber,
  formatDateToUtcYYYYMMDD,
  parseDateFromUtcYYYYMMDD,
  type EventStore,
} from '@event-driven-io/emmett';
import {
  Created,
  Forbidden,
  NoContent,
  NotFound,
  OK,
  on,
  type WebApiSetup,
} from '@event-driven-io/emmett-expressjs';
import { type Request, type Router } from 'express';
import {
  checkIn,
  checkOut,
  recordCharge,
  recordPayment,
  type CheckIn,
  type CheckOut,
  type RecordCharge,
  type RecordPayment,
} from './businessLogic';
import { evolve, initialState, toGuestStayAccountId } from './guestStayAccount';

export const handle = CommandHandler(evolve, initialState);

type CheckInRequest = Request<Partial<{ guestId: string; roomId: string }>>;

type RecordChargeRequest = Request<
  Partial<{ guestId: string; roomId: string; checkInDate: string }>,
  unknown,
  Partial<{ amount: number }>
>;

type RecordPaymentRequest = Request<
  Partial<{ guestId: string; roomId: string; checkInDate: string }>,
  unknown,
  Partial<{ amount: number }>
>;

type CheckOutRequest = Request<
  Partial<{ guestId: string; roomId: string; checkInDate: string }>,
  unknown,
  unknown
>;

type GetShoppingCartRequest = Request<
  Partial<{ guestId: string; roomId: string; checkInDate: string }>,
  unknown,
  unknown
>;

export const guestStayAccountsApi =
  (
    eventStore: EventStore,
    doesGuestStayExist: (
      guestId: string,
      roomId: string,
      day: Date,
    ) => Promise<boolean>,
    getCurrentTime: () => Date,
  ): WebApiSetup =>
  (router: Router) => {
    // Check In
    router.post(
      '/guests/:guestId/stays/:roomId',
      on(async (request: CheckInRequest) => {
        const guestId = assertNotEmptyString(request.params.guestId);
        const roomId = assertNotEmptyString(request.params.roomId);
        const now = getCurrentTime();

        if (!(await doesGuestStayExist(guestId, roomId, now)))
          return Forbidden();

        const guestStayAccountId = toGuestStayAccountId(guestId, roomId, now);

        const command: CheckIn = {
          type: 'CheckIn',
          data: {
            guestId,
            roomId,
          },
          metadata: { now },
        };

        await handle(eventStore, guestStayAccountId, (state) =>
          checkIn(command, state),
        );

        return Created({
          url: `/guests/${guestId}/stays/${roomId}/periods/${formatDateToUtcYYYYMMDD(now)}`,
        });
      }),
    );

    // Record Charge
    router.post(
      '/guests/:guestId/stays/:roomId/periods/:checkInDate/charges',
      on(async (request: RecordChargeRequest) => {
        const guestStayAccountId = parseGuestStayAccountId(request.params);

        const command: RecordCharge = {
          type: 'RecordCharge',
          data: {
            guestStayAccountId,
            amount: assertPositiveNumber(Number(request.body.amount)),
          },
          metadata: { now: getCurrentTime() },
        };

        await handle(eventStore, guestStayAccountId, (state) =>
          recordCharge(command, state),
        );

        return NoContent();
      }),
    );

    // Record Payment
    router.post(
      '/guests/:guestId/stays/:roomId/periods/:checkInDate/payments',
      on(async (request: RecordPaymentRequest) => {
        const guestStayAccountId = parseGuestStayAccountId(request.params);

        const command: RecordPayment = {
          type: 'RecordPayment',
          data: {
            guestStayAccountId,
            amount: assertPositiveNumber(Number(request.body.amount)),
          },
          metadata: { now: getCurrentTime() },
        };

        await handle(eventStore, guestStayAccountId, (state) =>
          recordPayment(command, state),
        );

        return NoContent();
      }),
    );

    // CheckOut Shopping Cart
    router.delete(
      '/guests/:guestId/stays/:roomId/periods/:checkInDate',
      on(async (request: CheckOutRequest) => {
        const guestStayAccountId = parseGuestStayAccountId(request.params);

        const command: CheckOut = {
          type: 'CheckOut',
          data: { guestStayAccountId },
          metadata: { now: getCurrentTime() },
        };

        let wasCheckedOut = false;

        await handle(eventStore, guestStayAccountId, (state) => {
          const result = checkOut(command, state);

          wasCheckedOut = result.type === 'GuestCheckedOut';

          return result;
        });

        return wasCheckedOut ? NoContent() : Forbidden();
      }),
    );

    // Get Shopping Cart
    router.get(
      '/guests/:guestId/stays/:roomId/periods/:checkInDate',
      on(async (request: GetShoppingCartRequest) => {
        const guestStayAccountId = parseGuestStayAccountId(request.params);

        const result = await eventStore.aggregateStream(guestStayAccountId, {
          evolve,
          initialState,
        });

        if (result === null) return NotFound();

        if (result.state.status !== 'Opened') return NotFound();

        return OK({
          body: result.state,
        });
      }),
    );
  };

const parseGuestStayAccountId = ({
  guestId,
  roomId,
  checkInDate,
}: {
  guestId?: string;
  roomId?: string;
  checkInDate?: string;
}) =>
  toGuestStayAccountId(
    assertNotEmptyString(guestId),
    assertNotEmptyString(roomId),
    parseDateFromUtcYYYYMMDD(assertNotEmptyString(checkInDate)),
  );
