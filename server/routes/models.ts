import { Router } from 'express';
import type { AgentType, ModelInfo, ModelsListResponse } from '../../shared/types.js';
import { getAdapter, agentFromQuery } from '../agent.js';
import { gatewayErrorFromWorker } from '../errors.js';

export const modelsRouter = Router();

// We don't track per-model creation time; OpenAI's model schema requires
// `created`, so we emit a stable placeholder.
const MODEL_CREATED = 0;

// GET /v1/models — the models a harness on this gateway can run on. The body is
// the OpenAI list shape ({ object: "list", data: [...] }) so standard clients
// work; the upstream provider rides in `owned_by` and label/source/is_default
// are additive extensions a UI groups on. `?agent=` selects the harness (default
// = the gateway's configured default), and the response echoes which `agent`
// answered.
modelsRouter.get('/', async (req, res, next) => {
  let agent: AgentType | undefined;
  try {
    // `?agent=` (omitted or empty) falls back to the configured default harness.
    agent = agentFromQuery(req.query.agent);
    const models = await getAdapter(agent).getModels();
    const data: ModelInfo[] = [];
    for (const group of models.groups) {
      for (const model of group.models) {
        data.push({
          id: model.id,
          object: 'model',
          created: MODEL_CREATED,
          owned_by: model.provider ?? group.provider,
          label: model.label,
          source: model.source,
          is_default: Boolean(model.isCurrentDefault),
        });
      }
    }
    const body: ModelsListResponse = {
      object: 'list',
      agent,
      default_model: models.defaultModel,
      default_provider: models.activeProvider,
      data,
    };
    res.json(body);
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Could not list models', agent));
  }
});
