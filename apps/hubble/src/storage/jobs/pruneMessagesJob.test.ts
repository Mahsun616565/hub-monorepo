import {
  Ed25519Signer,
  Factories,
  FarcasterNetwork,
  Message,
  MessageType,
  PruneMessageHubEvent,
  VERIFICATIONS_SIZE_LIMIT_DEFAULT,
} from "@farcaster/hub-nodejs";
import { jestRocksDB } from "../db/jestUtils.js";
import Engine from "../engine/index.js";
import { seedSigner } from "../engine/seed.js";
import { PruneMessagesJobScheduler } from "./pruneMessagesJob.js";
import { FARCASTER_EPOCH, getFarcasterTime } from "@farcaster/core";
import { setReferenceDateForTest } from "../../utils/versions.js";

const db = jestRocksDB("jobs.pruneMessagesJob.test");

const engine = new Engine(db, FarcasterNetwork.TESTNET);
const scheduler = new PruneMessagesJobScheduler(engine);

// Use farcaster timestamp
const seedMessagesFromTimestamp = async (engine: Engine, fid: number, signer: Ed25519Signer, timestamp: number) => {
  const castAdd = await Factories.CastAddMessage.create({ data: { fid, timestamp } }, { transient: { signer } });
  const reactionAdd = await Factories.ReactionAddMessage.create(
    { data: { fid, timestamp } },
    { transient: { signer } },
  );
  const linkAdd = await Factories.LinkAddMessage.create({ data: { fid, timestamp } }, { transient: { signer } });
  const proofs = await Factories.VerificationAddEthAddressMessage.createList(
    VERIFICATIONS_SIZE_LIMIT_DEFAULT + 1,
    { data: { fid, timestamp } },
    { transient: { signer } },
  );

  return engine.mergeMessages([castAdd, reactionAdd, linkAdd, ...proofs]);
};

let prunedMessages: Message[] = [];

const pruneMessageListener = (event: PruneMessageHubEvent) => {
  prunedMessages.push(event.pruneMessageBody.message);
};

beforeAll(async () => {
  await engine.start();
  setReferenceDateForTest(100000000000000000000000);
  engine.eventHandler.on("pruneMessage", pruneMessageListener);
});

beforeEach(() => {
  prunedMessages = [];
});

afterAll(async () => {
  engine.eventHandler.off("pruneMessage", pruneMessageListener);
  await engine.stop();
});

describe("doJobs", () => {
  test("succeeds without fids", async () => {
    const result = await scheduler.doJobs();
    expect(result._unsafeUnwrap()).toEqual(undefined);
  });

  test(
    "prunes messages for all fids",
    async () => {
      const currentTime = getFarcasterTime()._unsafeUnwrap();

      const fid1 = Factories.Fid.build();

      const signer1 = Factories.Ed25519Signer.build();
      const signer1Key = (await signer1.getSignerKey())._unsafeUnwrap();
      await seedSigner(engine, fid1, signer1Key);
      await seedMessagesFromTimestamp(engine, fid1, signer1, currentTime);

      const fid2 = Factories.Fid.build();

      const signer2 = Factories.Ed25519Signer.build();
      const signer2Key = (await signer2.getSignerKey())._unsafeUnwrap();
      await seedSigner(engine, fid2, signer2Key);
      await seedMessagesFromTimestamp(engine, fid2, signer2, currentTime);

      for (const fid of [fid1, fid2]) {
        const casts = await engine.getCastsByFid(fid);
        expect(casts._unsafeUnwrap().messages.length).toEqual(1);

        const reactions = await engine.getReactionsByFid(fid);
        expect(reactions._unsafeUnwrap().messages.length).toEqual(1);

        const links = await engine.getLinksByFid(fid);
        expect(links._unsafeUnwrap().messages.length).toEqual(1);

        const verifications = await engine.getVerificationsByFid(fid);
        expect(verifications._unsafeUnwrap().messages.length).toEqual(VERIFICATIONS_SIZE_LIMIT_DEFAULT + 1);
      }

      const nowOrig = Date.now;
      // advance 1 month to get beyond the PRUNE_STOP_TIMESTAMP
      Date.now = () => FARCASTER_EPOCH + (currentTime + 60 * 60 * 24 * 30) * 1000;
      try {
        const result = await scheduler.doJobs();
        expect(result._unsafeUnwrap()).toEqual(undefined);
      } finally {
        Date.now = nowOrig;
      }

      for (const fid of [fid1, fid2]) {
        // These messages are not pruned (under size limit)
        const casts = await engine.getCastsByFid(fid);
        expect(casts._unsafeUnwrap().messages.length).toEqual(1);

        const reactions = await engine.getReactionsByFid(fid);
        expect(reactions._unsafeUnwrap().messages.length).toEqual(1);

        const links = await engine.getLinksByFid(fid);
        expect(links._unsafeUnwrap().messages.length).toEqual(1);

        // These are pruned based on size
        const verifications = await engine.getVerificationsByFid(fid);
        expect(verifications._unsafeUnwrap().messages.length).toEqual(25);
      }

      expect(prunedMessages.length).toEqual(2); // 1 verification for each of the 2 fids
      expect(prunedMessages.filter((m) => m.data?.type !== MessageType.VERIFICATION_ADD_ETH_ADDRESS)).toEqual([]);
    },
    15 * 1000,
  );
});
