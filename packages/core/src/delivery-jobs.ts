import PgBoss from "pg-boss";

/** One queue job per saved GitHub delivery. The worker calls GitHub; the webhook does not. */
export const processDeliveryQueue = "process-delivery";

export type ProcessDeliveryJob = {
  deliveryId: string;
};

export async function ensureProcessDeliveryQueue(boss: PgBoss): Promise<void> {
  if (await boss.getQueue(processDeliveryQueue)) {
    return;
  }
  try {
    // Stately plus the delivery id keeps a second send from stacking another job for the same delivery.
    await boss.createQueue(processDeliveryQueue, { name: processDeliveryQueue, policy: "stately" });
  } catch (error) {
    if (await boss.getQueue(processDeliveryQueue)) {
      return;
    }
    throw error;
  }
}

export async function sendDeliveryJob(boss: PgBoss, deliveryId: string): Promise<void> {
  await ensureProcessDeliveryQueue(boss);
  await boss.send(processDeliveryQueue, { deliveryId }, { singletonKey: deliveryId });
}

export type DeliveryPublisher = {
  enqueue(deliveryId: string): Promise<void>;
  stop(): Promise<void>;
};

/** Send-only pg-boss client. The worker process is the one that calls GitHub. */
export async function startDeliveryPublisher(connectionString: string): Promise<DeliveryPublisher> {
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false, max: 2 });
  boss.on("error", (error: Error) => console.error(`pg-boss error: ${error.message}`));
  await boss.start();
  await ensureProcessDeliveryQueue(boss);
  return {
    enqueue: (deliveryId) => sendDeliveryJob(boss, deliveryId),
    stop: () => boss.stop({ graceful: false, wait: false }),
  };
}
