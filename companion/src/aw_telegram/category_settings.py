"""Server-persisted effective categories; never load aw-client stock defaults."""
from dataclasses import dataclass
import hashlib
import json
import re
from .models import category_key


class CategorySettingsUnsupported(ValueError):
    pass


@dataclass(frozen=True)
class EffectiveCategories:
    rules: list[tuple[tuple[str, ...], dict]]
    catalog: list[dict]
    revision: str
    source: str
    warnings: tuple[str, ...] = ()


# Comparison only: aw-webui src/util/classes.ts defaultCategories,
# LEGACY_DEFAULT_COLORS, ruleSignature and matchesInstallDefault. These values
# never supply query rules; only the server-persisted categories do that.
# Reference SHA256: 0861880077762ad8486b360a6bfcbe2e3b639654d393feaa040f77513f1c4c33
_UNSET = object()
_INSTALL_CLASSES = {
    ('Work',): ('Google Docs|libreoffice|ReText', False, '#4ADE80', '#0F0', 10),
    ('Work', 'Programming'): ('GitHub|Stack Overflow|BitBucket|Gitlab|vim|Spyder|kate|Ghidra|Scite', False, None, None, _UNSET),
    ('Work', 'Programming', 'ActivityWatch'): ('ActivityWatch|aw-', True, None, None, _UNSET),
    ('Work', 'Image'): ('GIMP|Inkscape', False, None, None, _UNSET),
    ('Work', 'Video'): ('Kdenlive', False, None, None, _UNSET),
    ('Work', 'Audio'): ('Audacity', False, None, None, _UNSET),
    ('Work', '3D'): ('Blender', False, None, None, _UNSET),
    ('Media',): (None, False, '#F87171', '#F33', _UNSET),
    ('Media', 'Games'): ('Minecraft|RimWorld', False, '#FB923C', '#F80', _UNSET),
    ('Media', 'Video'): ('YouTube|Plex|VLC', False, '#F87171', '#F33', _UNSET),
    ('Media', 'Social Media'): ('reddit|Facebook|Twitter|Instagram|devRant', True, '#FACC15', '#FCC400', _UNSET),
    ('Media', 'Music'): ('Spotify|Deezer', True, '#A3E635', '#A8FC00', _UNSET),
    ('Comms',): (None, False, '#67E8F9', '#9FF', _UNSET),
    ('Comms', 'IM'): ('Messenger|Telegram|Signal|WhatsApp|Rambox|Slack|Riot|Element|Discord|Nheko|NeoChat|Mattermost', False, None, None, _UNSET),
    ('Comms', 'Email'): ('Gmail|Thunderbird|mutt|alpine', False, None, None, _UNSET),
    ('Uncategorized',): (None, False, '#CCC', None, _UNSET),
}


def _legacy_looks_unconfigured(categories: list) -> bool:
    if len(categories) != len(_INSTALL_CLASSES):
        return False
    paths = [_path(cat) for cat in categories]
    if len(set(paths)) != len(paths) or set(paths) != _INSTALL_CLASSES.keys():
        return False
    for cat, path in zip(categories, paths):
        regex, ignore_case, color, legacy_color, score = _INSTALL_CLASSES[path]
        rule = cat.get('rule')
        rule = rule if isinstance(rule, dict) else {}
        is_regex = rule.get('type') == 'regex'
        priority = rule.get('priority')
        signature = (is_regex, rule.get('regex') if is_regex else None,
                     bool(rule.get('ignore_case')), rule.get('select_keys'),
                     priority if priority is not None else rule.get('weight'))
        if signature != (regex is not None, regex, ignore_case, None, None):
            return False
        data = cat.get('data')
        data = data if isinstance(data, dict) else {}
        stored_color = data.get('color')
        if isinstance(stored_color, str) and stored_color and stored_color != color:
            if legacy_color is None or stored_color.upper() != legacy_color.upper():
                return False
        if 'score' in data and data['score'] != score:
            return False
    return True


def resolve_categories(settings: dict) -> EffectiveCategories:
    if not isinstance(settings, dict):
        raise CategorySettingsUnsupported('missing_category_settings')
    sets = settings.get('category_sets')
    warnings = []
    if sets:
        if not isinstance(sets, list):
            raise CategorySettingsUnsupported('invalid_category_sets')
        by_id = {}
        for group in sets:
            if not isinstance(group, dict) or not isinstance(group.get('id'), str) or not isinstance(group.get('categories'), list) or group['id'] in by_id:
                raise CategorySettingsUnsupported('invalid_category_sets')
            by_id[group['id']] = group
        stored_active = settings.get('active_set_ids')
        if stored_active is not None and not isinstance(stored_active, list):
            raise CategorySettingsUnsupported('invalid_active_sets')
        active = stored_active or [sets[0]['id']]
        if not isinstance(active, list) or any(not isinstance(i, str) for i in active):
            raise CategorySettingsUnsupported('invalid_active_sets')
        if any(i not in by_id for i in active):
            # The server cannot reveal build-time UI presets. Require the caller
            # to resolve those rather than silently choosing a different taxonomy.
            raise CategorySettingsUnsupported('unresolved_active_set_or_preset')
        ordered = [by_id[i] for i in dict.fromkeys(active)]
        hidden = set()
        tombstones = ordered[0].get('tombstones', [])
        if not isinstance(tombstones, list):
            raise CategorySettingsUnsupported('invalid_tombstones')
        for raw in tombstones:
            try:
                path = json.loads(raw)
                category_key(path)
                hidden.add(tuple(path))
            except (TypeError, ValueError):
                raise CategorySettingsUnsupported('invalid_tombstones') from None
        categories, seen = [], set()
        for index, group in enumerate(ordered):
            for cat in group['categories']:
                path = _path(cat)
                if path not in seen and (index == 0 or path not in hidden):
                    categories.append(cat)
                    seen.add(path)
        source = 'category_sets'
    else:
        if sets is not None and not isinstance(sets, list):
            raise CategorySettingsUnsupported('invalid_category_sets')
        if settings.get('active_set_ids'):
            raise CategorySettingsUnsupported('unresolved_active_set_or_preset')
        if 'classes' not in settings or not isinstance(settings['classes'], list):
            raise CategorySettingsUnsupported('missing_category_settings')
        categories = settings['classes']
        source = 'classes'
        # A first-run theme save can persist unchanged install categories while
        # the UI activates an unavailable build preset. Real rule/color/score
        # edits follow the persisted legacy path, even with all stock names.
        if _legacy_looks_unconfigured(categories):
            raise CategorySettingsUnsupported('legacy_install_defaults_require_persisted_sets')
    rules, paths = [], {}
    for cat in categories:
        path = _path(cat)
        if path in paths:
            raise CategorySettingsUnsupported('duplicate_category_path')
        paths[path] = True
        rule = cat.get('rule')
        if rule is None or isinstance(rule, dict) and rule.get('type') in (None, 'none'):
            continue
        if not isinstance(rule, dict) or rule.get('type') != 'regex' or not isinstance(rule.get('regex'), str):
            raise CategorySettingsUnsupported('unsupported_rule')
        if set(rule) - {'type', 'regex', 'ignore_case', 'select_keys', 'priority', 'weight'}:
            raise CategorySettingsUnsupported('unsupported_rule_fields')
        normalized = {k: v for k, v in rule.items() if k != 'select_keys'}
        if not rule['regex']:
            continue
        try:
            re.compile(rule['regex'])
        except re.error:
            raise CategorySettingsUnsupported('invalid_regex') from None
        if 'ignore_case' in rule and type(rule['ignore_case']) is not bool:
            raise CategorySettingsUnsupported('invalid_ignore_case')
        for key in ('priority', 'weight'):
            if key in rule and type(rule[key]) is not int:
                raise CategorySettingsUnsupported('invalid_rule_priority')
        keys = rule.get('select_keys')
        if keys is not None:
            if not isinstance(keys, list):
                raise CategorySettingsUnsupported('invalid_select_keys')
            keys = list(dict.fromkeys(k for k in keys if isinstance(k, str) and k))
            if set(keys) - {'app', 'title'}:
                raise CategorySettingsUnsupported('browser_or_custom_enrichment_unsupported')
            if keys:
                normalized['select_keys'] = keys
        rules.append((path, normalized))
    for path in list(paths):
        for depth in range(1, len(path)):
            paths[path[:depth]] = True
    if len(paths) > 1023:
        raise CategorySettingsUnsupported('category_catalog_too_large')
    catalog = [{'id': category_key(list(p)), 'path': list(p)} for p in paths]
    catalog.append({'id': 'uncategorized', 'path': None})
    revision = hashlib.sha256(json.dumps([rules, catalog], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return EffectiveCategories(rules, catalog, revision, source, tuple(warnings))


def _path(category) -> tuple[str, ...]:
    try:
        path = category['name']
        category_key(path)
        return tuple(path)
    except (KeyError, TypeError, ValueError):
        raise CategorySettingsUnsupported('invalid_category_path') from None
