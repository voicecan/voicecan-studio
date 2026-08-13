import type { DeliveryIntent, NotificationTarget } from '../../../shared/contracts.js';

export type DeliveryUseCases = {
  publish(recordingId: string, target: NotificationTarget): Promise<DeliveryIntent>;
  refresh(recordingId: string, deliveryId: string): Promise<DeliveryIntent>;
  cancel(recordingId: string, deliveryId: string): Promise<DeliveryIntent>;
};
