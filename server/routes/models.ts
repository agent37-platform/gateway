import { Router } from 'express';
import type { ModelInfo } from '../../shared/types.js';
import { getDefaultAdapter } from '../agent.js';
import { gatewayErrorFromWorker } from '../errors.js';

export const modelsRouter = Router();

// GET /v1/models — the models this instance's agent can run on.
modelsRouter.get('/', async (_req, res, next) => {
  try {
    const models = await getDefaultAdapter().getModels();
    const data: ModelInfo[] = [];
    for (const group of models.groups) {
      for (const model of group.models) {
        data.push({
          id: model.id,
          label: model.label,
          provider: model.provider ?? (group.provider || null),
          is_default: Boolean(model.isCurrentDefault),
        });
      }
    }
    res.json({
      default_model: models.defaultModel,
      default_provider: models.activeProvider,
      data,
    });
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Could not list models'));
  }
});
