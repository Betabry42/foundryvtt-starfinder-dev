import { SFRPGEffectType, SFRPGModifierType, SFRPGModifierTypes } from "../../../../modifiers/types.js";

export default function(engine) {
    engine.closures.add("calculateHitpoints", (fact, context) => {
        const data = fact.data;

        const addModifier = (bonus, data, item, localizationKey) => {
            if (bonus.modifierType === SFRPGModifierType.FORMULA) {
                if (item.rolledMods) {
                    item.rolledMods.push({mod: bonus.modifier, bonus: bonus});
                } else {
                    item.rolledMods = [{mod: bonus.modifier, bonus: bonus}];
                }

                return 0;
            }

            let computedBonus = 0;
            try {
                const roll = Roll.create(bonus.modifier.toString(), data).evaluate({maximize: true});
                computedBonus = roll.total;
            } catch {}

            if (computedBonus !== 0 && localizationKey) {
                item.tooltip.push(game.i18n.format(localizationKey, {
                    type: game.i18n.format(`SFRPG.ModifierType${bonus.type.capitalize()}`),
                    mod: computedBonus.signedString(),
                    source: bonus.name
                }));
            }

            return computedBonus;
        };

        let hpMax = 0; // Race HP + (Class HP per level * Class Level) + Modifiers

        // Race bonus
        if (fact.races && fact.races.length > 0) {
            for (const race of fact.races) {
                const raceData = race.system;

                hpMax += raceData.hp.value;

                data.attributes.hp.tooltip.push(game.i18n.format("SFRPG.ActorSheet.Header.Hitpoints.RacialTooltip", {
                    mod: raceData.hp.value,
                    source: race.name
                }));
            }
        }

        // Class bonus
        if (fact.classes && fact.classes.length > 0) {
            for (const cls of fact.classes) {
                const classData = cls.system;

                let classBonus = Math.floor(classData.levels * classData.hp.value);
                hpMax += classBonus;

                data.attributes.hp.tooltip.push(game.i18n.format("SFRPG.ActorSheet.Header.Hitpoints.ClassTooltip", {
                    mod: classBonus,
                    source: cls.name
                }));
            }
        }

        // Iterate through any modifiers that affect HP
        let filteredModifiers = fact.modifiers.filter(mod => {
            return (mod.enabled || mod.modifierType === "roll") && mod.effectType == SFRPGEffectType.HIT_POINTS;
        });
        filteredModifiers = context.parameters.stackModifiers.process(filteredModifiers, context);

        let bonus = Object.entries(filteredModifiers).reduce((sum, mod) => {
            if (mod[1] === null || mod[1].length < 1) return sum;

            if ([SFRPGModifierTypes.CIRCUMSTANCE, SFRPGModifierTypes.UNTYPED].includes(mod[0])) {
                for (const bonus of mod[1]) {
                    sum += addModifier(bonus, data, data.attributes.hp, "SFRPG.AbilityScoreBonusTooltip");
                }
            } else {
                sum += addModifier(mod[1], data, data.attributes.hp, "SFRPG.AbilityScoreBonusTooltip");
            }

            return sum;
        }, 0);

        hpMax += bonus;

        data.attributes.hp.max = hpMax;

        return fact;
    }, { required: ["stackModifiers"], closureParameters: ["stackModifiers"] });
}
