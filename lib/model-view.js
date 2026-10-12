// Kept only for legacy clients and synthetic transport fixtures.
export const CURRENT_SELECTION = Object.freeze({ providerId: 'dsh', modelId: 'current', options: { reasoningLevel: 'desktop' } });
// The original picker filters out providers without an API type. This is a UI
// compatibility marker only: no endpoint/key is sent, and DSH executes all calls.
const providerConfig = () => ({ visibility: 'visible', api: { type: 'openai-chat-completions' } });
export function currentModelView() {
  return { revision: 1, effectiveSelection: CURRENT_SELECTION, preferredSelection: CURRENT_SELECTION,
    providers: [{ providerId: 'dsh', providerName: 'DSH', config: providerConfig(), models: [{
      modelId: 'current', config: { enabled: true,
        optionSpecs: { reasoningLevel: { values: ['desktop'] } },
        properties: { inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } },
      },
    }] }],
  };
}

export function toRemoteSelection(selection, catalog) {
  if (!selection) return CURRENT_SELECTION;
  const model = catalog?.groups.find(g => g.id === selection.provider)?.models.find(m => m.id === selection.model);
  return { providerId: selection.provider, modelId: selection.model,
    options: { reasoningLevel: selection.reasoningEffort ?? model?.reasoning?.defaultEffort ?? model?.reasoning?.efforts[0]?.id ?? 'default' } };
}

export function resolveSelection(catalog, selection) {
  if (!selection || (selection.providerId === 'dsh' && selection.modelId === 'current')) return { ...catalog.default };
  if (Object.keys(selection).some(k => !['providerId', 'modelId', 'options'].includes(k))
    || Object.keys(selection.options ?? {}).some(k => k !== 'reasoningLevel')) throw new Error('Unsupported model options');
  const model = catalog.groups.find(g => g.id === selection.providerId)?.models.find(m => m.id === selection.modelId);
  if (!model) throw new Error('Model is not available in DSH');
  const effort = selection.options?.reasoningLevel ?? model.reasoning?.defaultEffort ?? model.reasoning?.efforts[0]?.id;
  if (model.reasoning?.efforts.length ? !model.reasoning.efforts.some(e => e.id === effort) : effort && effort !== 'default') throw new Error('Reasoning level is not available in DSH');
  return { provider: selection.providerId, model: selection.modelId,
    ...(model.reasoning?.efforts.length ? { reasoningEffort: effort } : {}) };
}

export function catalogModelView(catalog, input) {
  const preferredSelection = toRemoteSelection(catalog.default, catalog);
  let effectiveSelection = preferredSelection;
  let selectionIssue;
  if (input?.selection) {
    try { effectiveSelection = toRemoteSelection(resolveSelection(catalog, input.selection), catalog); }
    catch { effectiveSelection = null; selectionIssue = 'model-not-found'; }
  }
  return { revision: 1, preferredSelection, effectiveSelection, ...(selectionIssue ? { selectionIssue } : {}),
    providers: catalog.groups.map(group => ({ providerId: group.id, providerName: group.name, config: providerConfig(),
      models: group.models.map(model => ({ modelId: model.id, config: { enabled: true,
        optionSpecs: { reasoningLevel: { values: model.reasoning?.efforts.length ? model.reasoning.efforts.map(e => e.id) : ['default'] } },
        properties: { inputFormat: { supportsText: true, supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } },
      } })) })),
  };
}
