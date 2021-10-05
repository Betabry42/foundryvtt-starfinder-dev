import { TraitSelectorSFRPG } from "../../apps/trait-selector.js";
import { ActorSheetFlags } from "../../apps/actor-flags.js";
import { ActorMovementConfig } from "../../apps/movement-config.js";
import { getSpellBrowser } from "../../packs/spell-browser.js";

import { moveItemBetweenActorsAsync, getFirstAcceptableStorageIndex, ActorItemHelper, containsItems } from "../actor-inventory.js";
import { RPC } from "../../rpc.js"

import { ItemDeletionDialog } from "../../apps/item-deletion-dialog.js"
import { InputDialog } from "../../apps/input-dialog.js"
import { SFRPG } from "../../config.js";

/**
 * Extend the basic ActorSheet class to do all the SFRPG things!
 * This sheet is an Abstract layer which is not used.
 * 
 * @type {ActorSheet}
 */
export class ActorSheetSFRPG extends ActorSheet {
    constructor(...args) {
        super(...args);

        this._filters = {
            inventory: new Set(),
            spellbook: new Set(),
            features: new Set()
        };

        this._tooltips = null;
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            scrollY: [
                ".tab.attributes",
                ".inventory .inventory-list",
                ".features .inventory-list",
                ".spellbook .inventory-list",
                ".modifiers .inventory-list"
            ],
            tabs: [
                {navSelector: ".tabs", contentSelector: ".sheet-body", initial: "attributes"},
                {navSelector: ".subtabs", contentSelector: ".modifiers-body", initial: "permanent"},
                {navSelector: ".biotabs", contentSelector: ".bio-body", initial: "biography"}
            ]
        });
    }

    /**
     * Add some extra data when rendering the sheet to reduce the amount of logic required within the template.
     */
    getData() {
        const isOwner = this.document.isOwner;
        const data = {
            actor: this.actor,
            data: duplicate(this.actor.data.data),
            isOwner: isOwner,
            isGM: game.user.isGM,
            limited: this.document.limited,
            options: this.options,
            editable: this.isEditable,
            cssClass: isOwner ? "editable" : "locked",
            isCharacter: this.document.data.type === "character",
            isShip: this.document.data.type === 'starship',
            isVehicle: this.document.data.type === 'vehicle',
            isDrone: this.document.data.type === 'drone',
            isNPC: this.document.data.type === 'npc',
            isHazard: this.document.data.type === 'hazard',
            config: CONFIG.SFRPG
        };

        data.items = this.actor.items.map(i => {
            i.data.labels = i.labels;
            return i.data;
        });
        data.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));
        data.labels = this.actor.labels || {};
        data.filters = this._filters;

        if (!data.data?.details?.biography?.fullBodyImage)
        {
            this.actor.data.data = mergeObject(this.actor.data.data, {
                details: {
                    biography: {
                        fullBodyImage: "systems/sfrpg/images/mystery-body.png"
                    }
                }
            }, {overwrite: false});
            this.actor.data.data.details.biography.fullBodyImage = "systems/sfrpg/images/mystery-body.png";
        }

        if (data.data.abilities) {
            // Ability Scores
            for (let [a, abl] of Object.entries(data.data.abilities)) {
                abl.label = CONFIG.SFRPG.abilities[a];
            }
        }

        if (data.data.skills) {
            // Update skill labels
            for (let [s, skl] of Object.entries(data.data.skills)) {                
                skl.ability = data.data.abilities[skl.ability].label.substring(0, 3);
                skl.icon = this._getClassSkillIcon(skl.value);

                let skillLabel = CONFIG.SFRPG.skills[s.substring(0, 3)];
                if (skl.subname) {
                    skillLabel += ` (${skl.subname})`;
                }

                skl.label = skillLabel;
                skl.hover = CONFIG.SFRPG.skillProficiencyLevels[skl.value];
            }

            data.data.skills = Object.keys(data.data.skills).sort().reduce((skills, key) => {
                skills[key] = data.data.skills[key];

                return skills;
            }, {});

            data.data.hasSkills = Object.values(data.data.skills).filter(x => x.enabled).length > 0;
        }

        if (data.data.traits) {
            this._prepareTraits(data.data.traits);
        }

        this._prepareItems(data);

        return data;
    }

    /**
     * Activate event listeners using the prepared sheet HTML
     * 
     * @param {JQuery} html The prepared HTML object ready to be rendered into the DOM
     */
    activateListeners(html) {
        super.activateListeners(html);

        html.find('[data-wpad]').each((i, e) => {
            let text = e.tagName === "INPUT" ? e.value : e.innerText,
                w = text.length * parseInt(e.getAttribute("data-wpad")) / 2;
            e.setAttribute("style", "flex: 0 0 " + w + "px;");
        });

        const filterLists = html.find(".filter-list");
        filterLists.each(this._initializeFilterItemList.bind(this));
        filterLists.on("click", ".filter-item", this._onToggleFilter.bind(this));

        html.find('.item .item-name h4').click(event => this._onItemSummary(event));
        html.find('.item .item-name h4').contextmenu(event => this._onItemSplit(event));

        if (!this.options.editable) return;
        
        html.find('.config-button').click(this._onConfigMenu.bind(this));

        html.find('.toggle-container').click(this._onToggleContainer.bind(this));

        html.find('.skill-proficiency').on("click contextmenu", this._onCycleClassSkill.bind(this));
        html.find('.trait-selector').click(this._onTraitSelector.bind(this));

        // Ability Checks
        html.find('.ability-name').click(this._onRollAbilityCheck.bind(this));

        // Roll Skill Checks
        html.find('.skill-name').click(this._onRollSkillCheck.bind(this));

        // Edit Skill
        html.find('h4.skill-name').contextmenu(this._onEditSkill.bind(this));

        // Add skill
        html.find('#add-profession').click(this._onAddSkill.bind(this));

        // Configure Special Flags
        html.find('.configure-flags').click(this._onConfigureFlags.bind(this));

        // Saves
        html.find('.save-name').click(this._onRollSave.bind(this));

        /* -------------------------------------------- */
        /*  Spellbook
        /* -------------------------------------------- */
        html.find('.spell-browse').click(ev => getSpellBrowser().render(true)); // Inventory Browser

        /* -------------------------------------------- */
        /*  Inventory
        /* -------------------------------------------- */

        // Create New Item
        html.find('.item-create').click(ev => this._onItemCreate(ev));

        // Update Inventory Item
        html.find('.item-edit').click(ev => {
            let itemId = $(ev.currentTarget).parents(".item").attr("data-item-id");
            const item = this.actor.items.get(itemId);
            // const item = this.actor.getEmbeddedEntity("Item", itemId);
            item.sheet.render(true);
        });

        // Delete Inventory Item
        html.find('.item-delete').click(ev => this._onItemDelete(ev));

        // Item Dragging
        let handler = ev => this._onDragStart(ev);
        html.find('li.item').each((i, li) => {
            li.setAttribute("draggable", true);
            li.addEventListener("dragstart", handler, false);
        });

        // Item Rolling
        html.find('.item .item-image').click(event => this._onItemRoll(event));

        // Roll attack from item 
        html.find('.item-action .attack').click(event => this._onItemRollAttack(event));

        // Roll damage for item
        html.find('.item-action .damage').click(event => this._onItemRollDamage(event));
        html.find('.item-action .healing').click(event => this._onItemRollDamage(event));

        // (De-)activate an item
        html.find('.item-detail .featActivate').click(event => this._onActivateFeat(event));
        html.find('.item-detail .featDeactivate').click(event => this._onDeactivateFeat(event));

        // Item Recharging
        html.find('.item .item-recharge').click(event => this._onItemRecharge(event));

        // Item Equipping
        html.find('.item .item-equip').click(event => this._onItemEquippedChange(event));

        // Condition toggling
        html.find('.conditions input[type="checkbox"]').change(this._onToggleConditions.bind(this));

        // Actor resource update
        html.find('.actor-resource-base-input').change(this._onActorResourceChanged.bind(this));
    }
    
    /** @override */
    render(force, options) {
        if (this.stopRendering) {
            return this;
        }
        
        return super.render(force, options);
    }

    async _render(...args) {
        await super._render(...args);

        if (this._tooltips === null) {
            this._tooltips = tippy.delegate(`#${this.id}`, {
                target: '[data-tippy-content]',
                allowHTML: true,
                arrow: false,
                placement: 'top-start',
                duration: [500, null],
                delay: [800, null],
                maxWidth: 600
            });
        }
    }

    async close(...args) {
        if (this._tooltips !== null) {
            for (const tooltip of this._tooltips) {
                tooltip.destroy();
            }

            this._tooltips = null;
        }

        return super.close(...args);
    }

    /** @override */
    _onChangeTab(event, tabs, active) {
        if (active === "modifiers") {
            this._tabs[1].activate("conditions");
        }

        super._onChangeTab();
    }

    _onConfigMenu(event) {
      event.preventDefault();
      const button = event.currentTarget;
      let app;
      switch ( button.dataset.action ) {
        case "movement":
          app = new ActorMovementConfig(this.object);
          break;
      }
      app?.render(true);
    }

    _prepareTraits(traits) {
        const map = {
            "dr": CONFIG.SFRPG.energyDamageTypes,
            "di": CONFIG.SFRPG.damageTypes,
            "dv": CONFIG.SFRPG.damageTypes,
            "ci": CONFIG.SFRPG.conditionTypes,
            "languages": CONFIG.SFRPG.languages,
            "weaponProf": CONFIG.SFRPG.weaponProficiencies,
            "armorProf": CONFIG.SFRPG.armorProficiencies
        };

        for (let [t, choices] of Object.entries(map)) {
            const trait = traits[t];
            if (!trait) continue;
            let values = [];
            if (trait.value) {
                values = trait.value instanceof Array ? trait.value : [trait.value];
            }
            trait.selected = values.reduce((obj, t) => {
                if (typeof t !== "object") obj[t] = choices[t];
                else {
                    for (const [key, value] of Object.entries(t))
                        obj[key] = `${choices[key]} ${value}`;
                }

                return obj;
            }, {});

            if (trait.custom) {
                trait.custom.split(';').forEach((c, i) => trait.selected[`custom${i + 1}`] = c.trim());
            }
            trait.cssClass = !isObjectEmpty(trait.selected) ? "" : "inactive";
        }
    }

    _prepareActorResource(actorResourceItem, actorData) {
        if (actorResourceItem?.type !== "actorResource") {
            return;
        }

        actorResourceItem.attributes = [];
        actorResourceItem.actorResourceData = null;
        if (actorResourceItem.data.type && actorResourceItem.data.subType) {
            actorResourceItem.attributes.push(`@resources.${actorResourceItem.data.type}.${actorResourceItem.data.subType}.base`);
            actorResourceItem.attributes.push(`@resources.${actorResourceItem.data.type}.${actorResourceItem.data.subType}.value`);

            if (actorResourceItem.data.base || actorResourceItem.data.base === 0) {
                actorResourceItem.actorResourceData = actorData.resources[actorResourceItem.data.type][actorResourceItem.data.subType];
            }
        }
    }

    /**
     * handle cycling whether a skill is a class skill or not
     * 
     * @param {Event} event A click or contextmenu event which triggered the handler
     * @private
     */
    _onCycleClassSkill(event) {
        event.preventDefault();

        const field = $(event.currentTarget).siblings('input[type="hidden"]');

        const level = parseFloat(field.val());
        const levels = [0, 3];

        let idx = levels.indexOf(level);

        if (event.type === "click") {
            field.val(levels[(idx === levels.length - 1) ? 0 : idx + 1]);
        } else if (event.type === "contextmenu") {
            field.val(levels[(idx === 0) ? levels.length - 1 : idx - 1]);
        }

        this._onSubmit(event);
    }

    /**
     * Handle editing a skill
     * @param {Event} event The originating contextmenu event
     */
    _onEditSkill(event) {
        event.preventDefault();
        let skillId = event.currentTarget.parentElement.dataset.skill;

        return this.actor.editSkill(skillId, {event: event});
    }

    /**
     * Handle adding a skill
     * @param {Event} event The originating contextmenu event
     */
    _onAddSkill(event) {
        event.preventDefault();

        return this.actor.addSkill({event: event});
    }

    /**
     * Handle creating a new Owned Item for the actor using initial data defined in the HTML dataset
     * @param {Event} event The originating click event
     */
    async _onItemCreate(event) {
        event.preventDefault();
        const header = event.currentTarget;
        let type = header.dataset.type;
        if (!type || type.includes(",")) {
            let types = duplicate(SFRPG.itemTypes);
            if (type) {
                let supportedTypes = type.split(',');
                for (let key of Object.keys(types)) {
                    if (!supportedTypes.includes(key)) {
                        delete types[key];
                    }
                }
            }

            let createData = {
                name: game.i18n.format("SFRPG.NPCSheet.Interface.CreateItem.Name"),
                type: type
            };

            let templateData = {upper: "Item", lower: "item", types: types},
            dlg = await renderTemplate(`systems/sfrpg/templates/apps/localized-entity-create.html`, templateData);

            new Dialog({
                title: game.i18n.format("SFRPG.NPCSheet.Interface.CreateItem.Title"),
                content: dlg,
                buttons: {
                    create: {
                        icon: '<i class="fas fa-check"></i>',
                        label: game.i18n.format("SFRPG.NPCSheet.Interface.CreateItem.Button"),
                        callback: html => {
                            const form = html[0].querySelector("form");
                            let formDataExtended = new FormDataExtended(form);
                            mergeObject(createData, formDataExtended.toObject());
                            if (!createData.name) {
                                createData.name = game.i18n.format("SFRPG.NPCSheet.Interface.CreateItem.Name");
                            }

                            this.onBeforeCreateNewItem(createData);

                            this.actor.createEmbeddedDocuments("Item", [createData]);
                        }
                    }
                },
                default: "create"
            }).render(true);
            return null;
        }

        const itemData = {
            name: `New ${type.capitalize()}`,
            type: type,
            data: duplicate(header.dataset)
        };
        delete itemData.data['type'];

        this.onBeforeCreateNewItem(itemData);

        return this.actor.createEmbeddedDocuments("Item", [itemData]);
    }

    onBeforeCreateNewItem(itemData) {

    }

    /**
     * Handle deleting an Owned Item for the actor
     * @param {Event} event The originating click event
     */
    async _onItemDelete(event) {
        event.preventDefault();

        let li = $(event.currentTarget).parents(".item"), 
            itemId = li.attr("data-item-id");

        let actorHelper = new ActorItemHelper(this.actor.id, this.token ? this.token.id : null, this.token ? this.token.parent.id : null);
        let item = actorHelper.getItem(itemId);

        if (event.shiftKey) {
            actorHelper.deleteItem(itemId, true).then(() => {
                li.slideUp(200, () => this.render(false));
            });
        } else {
            let containsItems = (item.data.data.container?.contents && item.data.data.container.contents.length > 0);
            ItemDeletionDialog.show(item.name, containsItems, (recursive) => {
                actorHelper.deleteItem(itemId, recursive).then(() => {
                    li.slideUp(200, () => this.render(false));
                });
            });
        }
    }

    _onItemRollAttack(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        return item.rollAttack({event: event});
    }

    _onItemRollDamage(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        return item.rollDamage({event: event});
    }

    async _onActivateFeat(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        item.setActive(true);
    }

    async _onDeactivateFeat(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        item.setActive(false);
    }

    /**
     * Handle rolling of an item from the Actor sheet, obtaining the Item instance and dispatching to it's roll method
     * @param {Event} event The triggering event
     */
    _onItemRoll(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        if (item.data.type === "spell") {
            return this.actor.useSpell(item, {configureDialog: !event.shiftKey});
        }

        else return item.roll();
    }

    /**
     * Handle attempting to recharge an item usage by rolling a recharge check
     * @param {Event} event The originating click event
     */
    _ontItemRecharge(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);
        return item.rollRecharge();
    }

    /**
     * Handle toggling the equipped state of an item.
     * @param {Event} event The originating click event
     */
    _onItemEquippedChange(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        item.update({
            ["data.equipped"]: !item.data.data.equipped
        });
    }

    /**
     * Toggles condition modifiers on or off.
     * 
     * @param {Event} event The triggering event.
     */
    _onToggleConditions(event) {
        event.preventDefault();

        const target = $(event.currentTarget);

        // Try find existing condition
        const conditionName = target.data('condition');

        this.actor.setCondition(conditionName, target[0].checked).then(() => {

            const flatfootedConditions = ["blinded", "cowering", "off-kilter", "pinned", "stunned"];
            let shouldBeFlatfooted = (conditionName === "flat-footed" && target[0].checked);
            for (const ffCondition of flatfootedConditions) {
                if (this.actor.hasCondition(ffCondition)) {
                    shouldBeFlatfooted = true;
                    break;
                }
            }

            if (shouldBeFlatfooted != this.actor.hasCondition("flat-footed")) {
                // This will trigger another sheet reload as the other condition gets created or deleted a moment later.
                const flatfooted = $('.condition.flat-footed');
                flatfooted.prop("checked", shouldBeFlatfooted).change();
            }
        });
    }

    _onActorResourceChanged(event) {
        event.preventDefault();
        const target = $(event.currentTarget);
        const resourceId = target.data('resourceId');
        const resourceItem = this.actor.items.get(resourceId);
        const newBaseValue = parseInt(target[0].value);

        if (!Number.isNaN(newBaseValue)) {
            resourceItem.update({"data.base": newBaseValue});
        } else {
            resourceItem.update({"data.base": 0});
        }
    }

    /**
     * Handle rolling a Save
     * @param {Event} event   The originating click event
     * @private
     */
    _onRollSave(event) {
        event.preventDefault();
        const save = event.currentTarget.parentElement.dataset.save;
        this.actor.rollSave(save, {event: event});
    }

    /**
     * Handle rolling a Skill check
     * @param {Event} event   The originating click event
     * @private
     */
    _onRollSkillCheck(event) {
        event.preventDefault();
        const skill = event.currentTarget.parentElement.dataset.skill;
        this.actor.rollSkill(skill, {event: event});
    }

    /**
     * Handle rolling an Ability check
     * @param {Event} event   The originating click event
     * @private
     */
    _onRollAbilityCheck(event) {
        event.preventDefault();
        let ability = event.currentTarget.parentElement.dataset.ability;
        this.actor.rollAbility(ability, {event: event});
    }

    /**
     * Handles reloading / replacing ammo or batteries in a weapon.
     * 
     * @param {Event} event The originating click event
     */
    async _onReloadWeapon(event) {
        event.preventDefault();

        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        return item.reload();
    }

    /**
     * Handles toggling the open/close state of a container.
     * 
     * @param {Event} event The originating click event
     */
    _onToggleContainer(event) {
        event.preventDefault();

        const itemId = event.currentTarget.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);

        const isOpen = item.data.data.container?.isOpen === undefined ? true : item.data.data.container.isOpen;

        return item.update({'data.container.isOpen': !isOpen});
    }

    /**
     * Get The font-awesome icon used to display if a skill is a class skill or not
     * 
     * @param {Number} level Flag that determines if a skill is a class skill or not
     * @returns {String}
     * @private
     */
    _getClassSkillIcon(level) {
        const icons = {
            0: '<i class="far fa-circle"></i>',
            3: '<i class="fas fa-check"></i>'
        };

        return icons[level];
    }

    /**
     * Handle rolling of an item form the Actor sheet, obtaining the item instance an dispatching to it's roll method.
     * 
     * @param {Event} event The html event
     */
    _onItemSummary(event) {
        event.preventDefault();
        let li = $(event.currentTarget).parents('.item'),
            item = this.actor.items.get(li.data('item-id')),
            chatData = item.getChatData({ secrets: this.actor.isOwner, rollData: this.actor.data.data });

        if (li.hasClass('expanded')) {
            let summary = li.children('.item-summary');
            summary.slideUp(200, () => summary.remove());
        } else {
            const desiredDescription = TextEditor.enrichHTML(chatData.description.short || chatData.description.value, {});
            let div = $(`<div class="item-summary">${desiredDescription}</div>`);
            let props = $(`<div class="item-properties"></div>`);
            chatData.properties.forEach(p => props.append(`<span class="tag" ${ p.tooltip ? ("data-tippy-content='" + p.tooltip + "'") : ""}>${p.name}</span>`));

            div.append(props);
            li.append(div.hide());

            div.slideDown(200, function() { /* noop */ });
        }
        li.toggleClass('expanded');

    }

    async _onItemSplit(event) {
        event.preventDefault();
        const li = $(event.currentTarget).parents('.item'),
            item = this.actor.items.get(li.data('item-id'));

        const itemQuantity = item.data.data.quantity;
        if (!itemQuantity || itemQuantity <= 1) {
            return;
        }

        if (containsItems(item)) {
            return;
        }

        const bigStack = Math.ceil(itemQuantity / 2.0);
        const smallStack = Math.floor(itemQuantity / 2.0);

        const actorHelper = new ActorItemHelper(this.actor.id, this.token ? this.token.id : null, this.token ? this.token.parent.id : null);

        const update = { "quantity": bigStack };
        await actorHelper.updateItem(item.id, update);

        const itemData = duplicate(item.data);
        itemData.id = null;
        itemData.data.quantity = smallStack;
        itemData.effects = [];
        await actorHelper.createItem(itemData);
    }

    _prepareSpellbook(data, spells) {
        const actorData = this.actor.data.data;

        const levels = {
            "always": -30,
            "innate": -20
        };

        const useLabels = {
            "-30": "-",
            "-20": "-",
            "-10": "-",
            "0": "&infin;"
        };

        const spellbookReduced = spells.reduce((spellBook, spell) => {
            const spellData = spell.data;

            const mode = spellData.preparation.mode || "";
            const lvl = levels[mode] || spellData.level || 0;
            const spellsPerDay = actorData.spells["spell" + lvl];

            if (!spellBook[lvl]) {
                spellBook[lvl] = {
                    level: lvl,
                    usesSlots: lvl > 0,
                    canCreate: this.actor.isOwner && (lvl >= 0),
                    canPrepare: (this.actor.data.type === 'character') && (lvl > 0),
                    label: lvl >= 0 ? CONFIG.SFRPG.spellLevels[lvl] : CONFIG.SFRPG.spellPreparationModes[mode],
                    spells: [],
                    uses: useLabels[lvl] || spellsPerDay.value || 0,
                    slots: useLabels[lvl] || spellsPerDay.max || 0,
                    dataset: {"type": "spell", "level": lvl}
                };

                if (actorData.spells.classes && actorData.spells.classes.length > 0) {
                    spellBook[lvl].classes = [];
                    if (spellsPerDay?.perClass) {
                        for (const [classKey, storedData] of Object.entries(spellsPerDay.perClass)) {
                            const classInfo = actorData.spells.classes.find(x => x.key === classKey);
                            if (storedData.max > 0) {
                                spellBook[lvl].classes.push({key: classKey, name: classInfo?.name || classKey, value: storedData.value || 0, max: storedData.max});
                            }
                        }
                    }
                }
            }

            spellBook[lvl].spells.push(spell);
            return spellBook;
        }, {});

        const spellbookValues = Object.values(spellbookReduced);
        spellbookValues.sort((a, b) => a.level - b.level);

        return spellbookValues;
    }

    /**
     * Creates an TraitSelectorSFRPG dialog
     * 
     * @param {Event} event HTML Event
     * @private
     */
    _onTraitSelector(event) {
        event.preventDefault();
        const a = event.currentTarget;
        const label = a.parentElement.querySelector('label');
        const options = {
            name: label.getAttribute("for"),
            title: label.innerText,
            choices: CONFIG.SFRPG[a.dataset.options]
        };

        new TraitSelectorSFRPG(this.actor, options).render(true);
    }

    /**
     * Handle toggling of filters to display a different set of owned items
     * @param {Event} event     The click event which triggered the toggle
     * @private
     */
    _onToggleFilter(event) {
        event.preventDefault();
        const li = event.currentTarget;
        const set = this._filters[li.parentElement.dataset.filter];
        const filter = li.dataset.filter;
        if (set.has(filter)) set.delete(filter);
        else set.add(filter);
        this.render();
    }

    /**
     * Iinitialize Item list filters by activating the set of filters which are currently applied
     * @private
     */
    _initializeFilterItemList(i, ul) {
        const set = this._filters[ul.dataset.filter];
        const filters = ul.querySelectorAll(".filter-item");
        for (let li of filters) {
            if (set.has(li.dataset.filter)) li.classList.add("active");
        }
    }

    /**
     * Determine whether an Owned Item will be shown based on the current set of filters
     * 
     * @return {Boolean}
     * @private
     */
    _filterItems(items, filters) {
        return items.filter(item => {
            const data = item.data;

            // Action usage
            for (let f of ["action", "move", "swift", "full", "reaction"]) {
                if (filters.has(f)) {
                    if ((data.activation && (data.activation.type !== f))) return false;
                }
            }
            if (filters.has("concentration")) {
                if (data.components.concentration !== true) return false;
            }

            // Equipment-specific filters
            if (filters.has("equipped")) {
                if (data.equipped && data.equipped !== true) return false;
            }
            return true;
        });
    }

    /**
     * Handle click events for the Traits tab button to configure special Character Flags
     */
    _onConfigureFlags(event) {
        event.preventDefault();
        new ActorSheetFlags(this.actor).render(true);
    }

    async _onDrop(event) {
        event.preventDefault();

        const dragData = event.dataTransfer.getData('text/plain');
        const parsedDragData = JSON.parse(dragData);
        if (!parsedDragData) {
            console.log("Unknown item data");
            return;
        }

        return this.processDroppedData(event, parsedDragData);
    }

    async processDroppedData(event, parsedDragData) {
        const targetActor = new ActorItemHelper(this.actor.id, this.token?.id, this.token?.parent?.id);
        if (!ActorItemHelper.IsValidHelper(targetActor)) {
            ui.notifications.warn(game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.DragToExternalTokenError"));
            return;
        }

        let targetContainer = null;
        if (event) {
            const targetId = $(event.target).parents('.item').attr('data-item-id')
            targetContainer = targetActor.getItem(targetId);
        }

        if (parsedDragData.type === "ItemCollection") {
            const msg = {
                target: targetActor.toObject(),
                source: {
                    actorId: null,
                    tokenId: parsedDragData.tokenId,
                    sceneId: parsedDragData.sceneId
                },
                draggedItems: parsedDragData.items,
                containerId: targetContainer ? targetContainer.id : null
            }

            const messageResult = RPC.sendMessageTo("gm", "dragItemFromCollectionToPlayer", msg);
            if (messageResult === "errorRecipientNotAvailable") {
                ui.notifications.warn(game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.ItemCollectionPickupNoGMError"));
            }
            return;
        } else if (parsedDragData.pack) {
            const pack = game.packs.get(parsedDragData.pack);
            const itemData = await pack.getDocument(parsedDragData.id);

            if (itemData.type === "class") {
                const existingClass = targetActor.findItem(x => x.type === "class" && x.name === itemData.name);
                if (existingClass) {
                    const levelUpdate = {};
                    levelUpdate["data.levels"] = existingClass.data.data.levels + 1;
                    existingClass.update(levelUpdate)
                    return existingClass;
                }
            }

            const createResult = await targetActor.createItem(itemData.data._source);
            const addedItem = targetActor.getItem(createResult[0].id);

            if (!(addedItem.type in SFRPG.containableTypes)) {
                targetContainer = null;
            }
            
            const itemInTargetActor = await moveItemBetweenActorsAsync(targetActor, addedItem, targetActor, targetContainer);
            if (itemInTargetActor === addedItem) {
                await this._onSortItem(event, itemInTargetActor.data);
                return itemInTargetActor;
            }

            return itemInTargetActor;
        } else if (parsedDragData.data) {
            const sourceActor = new ActorItemHelper(parsedDragData.actorId, parsedDragData.tokenId, parsedDragData.sceneId);
            if (!ActorItemHelper.IsValidHelper(sourceActor)) {
                ui.notifications.warn(game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.DragFromExternalTokenError"));
                return;
            }

            const itemToMove = await sourceActor.getItem(parsedDragData.data._id);

            if (event.shiftKey) {
                InputDialog.show(
                    game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.AmountToTransferTitle"),
                    game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.AmountToTransferMessage"), {
                    amount: {
                        name: game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.AmountToTransferLabel"),
                        label: game.i18n.format("SFRPG.ActorSheet.Inventory.Interface.AmountToTransferInfo", { max: itemToMove.data.data.quantity }),
                        placeholder: itemToMove.data.data.quantity,
                        validator: (v) => {
                            let number = Number(v);
                            if (Number.isNaN(number)) {
                                return false;
                            }

                            if (number < 1) {
                                return false;
                            }

                            if (number > itemToMove.data.data.quantity) {
                                return false;
                            }
                            return true;
                        }
                    }
                }, (values) => {
                    const itemInTargetActor = moveItemBetweenActorsAsync(sourceActor, itemToMove, targetActor, targetContainer, values.amount);
                    if (itemInTargetActor === itemToMove) {
                        this._onSortItem(event, itemInTargetActor.data);
                    }
                });
            } else {
                const itemInTargetActor = await moveItemBetweenActorsAsync(sourceActor, itemToMove, targetActor, targetContainer);
                if (itemInTargetActor === itemToMove) {
                    return await this._onSortItem(event, itemInTargetActor.data);
                }
            }
        } else {
            const sidebarItem = game.items.get(parsedDragData.id);
            if (sidebarItem) {
                if (sidebarItem.type === "class") {
                    const existingClass = targetActor.findItem(x => x.type === "class" && x.name === sidebarItem.name);
                    if (existingClass) {
                        const levelUpdate = {};
                        levelUpdate["data.levels"] = existingClass.data.data.levels + 1;
                        existingClass.update(levelUpdate)
                        return existingClass;
                    }
                }

                const addedItemResult = await targetActor.createItem(duplicate(sidebarItem.data));
                if (addedItemResult.length > 0) {
                    const addedItem = targetActor.getItem(addedItemResult[0].id);

                    if (targetContainer) {
                        let newContents = [];
                        if (targetContainer.data.data.container?.contents) {
                            newContents = duplicate(targetContainer.data.data.container?.contents || []);
                        }

                        const preferredStorageIndex = getFirstAcceptableStorageIndex(targetContainer, addedItem) || 0;
                        newContents.push({id: addedItem.id, index: preferredStorageIndex});
                        
                        const update = { id: targetContainer.id, "data.container.contents": newContents };
                        await targetActor.updateItem(update);
                    }

                    return addedItem;
                }
                return null;
            }
            
            console.log("Unknown item source: " + JSON.stringify(parsedDragData));
        }
    }

    processItemContainment(items, pushItemFn) {
        const preprocessedItems = [];
        const containedItems = [];
        for (const item of items) {
            const itemData = {
                item: item,
                parent: items.find(x => x.data.container?.contents && x.data.container.contents.find(y => y.id === item._id)),
                contents: []
            };
            preprocessedItems.push(itemData);

            if (!itemData.parent) {
                pushItemFn(item.type, itemData);
            } else {
                containedItems.push(itemData);
            }
        }

        for (const item of containedItems) {
            const parent = preprocessedItems.find(x => x.item._id === item.parent._id);
            if (parent) {
                parent.contents.push(item);
            }
        }
    }
}