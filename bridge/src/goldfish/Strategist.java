package goldfish;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import forge.ai.ComputerUtilMana;
import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.zone.ZoneType;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * The "advanced bot": Forge's AI, steered by a short plan from Claude (llm.py). Once per bot turn (and at the
 * mulligan) the game state goes to Claude, which answers with what to cast first, what to hold and how to attack.
 * When the opponent puts something on the stack and the bot could answer at instant speed, Claude also decides
 * whether and how to respond.
 * Forge still plays every card, so rules, targets and mana stay correct; anything missing, illegal or failed
 * falls back to Forge's own decision.
 */
final class Strategist extends LobbyPlayerAi {
    private final Consumer<String> announce;

    Strategist(String name, String aiProfile, Consumer<String> announce) {
        super(name, null);
        setAiProfile(aiProfile);
        this.announce = announce;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        final Player p = new Player(getName(), game, id);
        p.setFirstController(new Controller(game, p, this));
        return p;
    }

    /** Runs llm.py (path and settings come from the environment forge.py sets); {} on any failure. */
    static JsonObject ask(String kind, JsonObject state) {
        try {
            final Process proc = new ProcessBuilder(System.getenv("GOLDFISH_PYTHON"), System.getenv("GOLDFISH_LLM_SCRIPT"))
                    .redirectError(ProcessBuilder.Redirect.INHERIT).start();
            final JsonObject req = new JsonObject();
            req.addProperty("kind", kind);
            req.add("state", state);
            try (OutputStream os = proc.getOutputStream()) {
                os.write(req.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!proc.waitFor(120, TimeUnit.SECONDS)) {
                proc.destroyForcibly();
                return new JsonObject();
            }
            final JsonElement out = JsonParser.parseString(new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            System.out.println("llm " + kind + ": " + out);
            return out.isJsonObject() ? out.getAsJsonObject() : new JsonObject();
        } catch (Exception e) {
            System.out.println("llm " + kind + " failed: " + e);
            return new JsonObject();
        }
    }

    final class Controller extends PlayerControllerAi {
        private int plannedTurn = -1;
        private JsonObject plan = new JsonObject();
        private final Set<Integer> tried = new HashSet<>();
        private final Set<Integer> consideredResponses = new HashSet<>(); // stack items Claude was already asked about

        Controller(Game game, Player p, LobbyPlayerAi lp) {
            super(game, p, lp);
        }

        @Override
        public boolean mulliganKeepHand(Player mulliganing, int cardsToReturn) {
            final boolean stock = super.mulliganKeepHand(mulliganing, cardsToReturn);
            if (mulliganing != player) {
                return stock;
            }
            final JsonObject state = state();
            state.addProperty("mulligans_taken", cardsToReturn);
            final JsonObject r = ask("mulligan", state);
            if (!r.has("keep")) {
                return stock;
            }
            say(r, r.get("keep").getAsBoolean() ? "Richard keeps: " : "Richard mulligans: ");
            return r.get("keep").getAsBoolean();
        }

        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            final Response response = considerResponse();
            if (response != null) {
                return response.play; // null = Claude chose to let it resolve
            }
            final boolean planning = ensurePlan();
            if (planning) {
                final PhaseType phase = getGame().getPhaseHandler().getPhase();
                if (phase == PhaseType.MAIN1 || phase == PhaseType.MAIN2) {
                    final SpellAbility first = castFirst();
                    if (first != null) {
                        return List.of(first);
                    }
                }
            }
            final List<SpellAbility> pick = super.chooseSpellAbilityToPlay();
            if (planning && pick != null && pick.stream().anyMatch(sa -> !sa.isLandAbility() && sa.getHostCard() != null
                    && ids("hold").contains(sa.getHostCard().getId()))) {
                return null; // the plan says to save this card; pass instead
            }
            return pick;
        }

        @Override
        public void declareAttackers(Player attacker, Combat combat) {
            super.declareAttackers(attacker, combat);
            if (!ensurePlan()) {
                return;
            }
            final String mode = plan.has("attack") ? plan.get("attack").getAsString() : "auto";
            final GameEntity target = combat.getDefenders().stream().filter(d -> d instanceof Player).findFirst().orElse(null);
            if (target == null || !(mode.equals("none") || mode.equals("all") || mode.equals("list"))) {
                return;
            }
            final Set<Integer> wanted = ids("attackers");
            combat.clearAttackers();
            for (Card c : attacker.getCardsIn(ZoneType.Battlefield)) {
                if (c.isCreature() && (mode.equals("all") || mode.equals("list") && wanted.contains(c.getId()))
                        && CombatUtil.canAttack(c, target)) {
                    combat.addAttacker(c, target);
                }
            }
            if (!CombatUtil.validateAttackers(combat)) { // e.g. a creature that must attack was left out
                combat.clearAttackers();
                super.declareAttackers(attacker, combat);
            }
        }

        /** Fetches this turn's plan once the bot reaches its main phase; true while a plan applies. */
        private boolean ensurePlan() {
            final PhaseHandler ph = getGame().getPhaseHandler();
            if (!ph.isPlayerTurn(player) || ph.getPhase() == null || ph.getPhase().isBefore(PhaseType.MAIN1)) {
                return false;
            }
            if (ph.getTurn() != plannedTurn) {
                plannedTurn = ph.getTurn();
                tried.clear();
                announce.accept("Richard is thinking…");
                plan = ask("turn", state());
                say(plan, "Richard's plan: ");
            }
            return true;
        }

        /** The first card from the plan's cast_first list the AI can cast now (each tried once per turn). */
        private SpellAbility castFirst() {
            for (int id : ids("cast_first")) {
                final Card c = getGame().findById(id);
                if (c == null || c.getController() != player || !tried.add(id)
                        || !(c.isInZone(ZoneType.Hand) || c.isInZone(ZoneType.Command)) || c.isLand()) {
                    continue;
                }
                for (SpellAbility sa : c.getSpells()) {
                    sa.setActivatingPlayer(player);
                    if (sa.canPlay() && ComputerUtilMana.canPayManaCost(sa, player, 0, false) && getAi().canPlaySa(sa).willingToPlay()) {
                        return sa;
                    }
                }
            }
            return null;
        }

        /** What to do about the opponent's stack item; {@code play == null} means pass. */
        private record Response(List<SpellAbility> play) { }

        /**
         * The response hook. When the opponent's spell, ability or trigger is on top of the stack and the bot holds
         * a legal, affordable instant-speed play, ask Claude (once per stack item) whether to answer it and how.
         * Returns null when Claude wasn't asked or gave no usable answer, so Forge's own AI decides as usual.
         */
        private Response considerResponse() {
            if (getGame().getStack().isEmpty()) {
                return null;
            }
            final SpellAbilityStackInstance top = getGame().getStack().peek();
            if (top.getActivatingPlayer() == player || !consideredResponses.add(top.getId())) {
                return null;
            }
            final List<SpellAbility> options = responseOptions();
            if (options.isEmpty()) {
                return null;
            }
            announce.accept("Richard is considering a response…");
            final JsonObject state = state();
            state.add("stack", stack());
            final JsonArray opts = new JsonArray();
            for (int i = 0; i < options.size(); i++) {
                opts.add(option(i, options.get(i)));
            }
            state.add("options", opts);
            final JsonObject r = ask("respond", state);
            if (!r.has("respond")) {
                return null; // no answer: Forge's AI decides
            }
            final int i = r.get("respond").getAsInt();
            if (i < 0 || i >= options.size()) {
                say(r, "Richard lets it resolve: ");
                return new Response(null);
            }
            final SpellAbility sa = options.get(i);
            if (!aim(sa, r)) {
                return null; // couldn't find legal targets for it: Forge's AI decides
            }
            say(r, "Richard responds: ");
            return new Response(List.of(sa));
        }

        /** Instant-speed things the bot could legally do right now and afford (mana abilities and lands excluded). */
        private List<SpellAbility> responseOptions() {
            final List<SpellAbility> out = new ArrayList<>();
            for (ZoneType z : new ZoneType[]{ZoneType.Hand, ZoneType.Battlefield, ZoneType.Command, ZoneType.Graveyard, ZoneType.Exile}) {
                for (Card c : player.getCardsIn(z)) {
                    for (SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                        if (sa.isManaAbility() || sa.isLandAbility() || out.size() >= 12) {
                            continue;
                        }
                        sa.setActivatingPlayer(player);
                        if (sa.canCastTiming(player) && ComputerUtilMana.canPayManaCost(sa, player, 0, false)
                                && (!sa.usesTargeting() || sa.getTargetRestrictions().hasCandidates(sa))) {
                            out.add(sa);
                        }
                    }
                }
            }
            return out;
        }

        /** Sets the targets Claude named if they're legal; otherwise lets Forge's AI pick. False if none work. */
        private boolean aim(SpellAbility sa, JsonObject r) {
            if (!sa.usesTargeting()) {
                return true;
            }
            sa.resetTargets();
            if (r.has("target_cards")) {
                for (JsonElement e : r.getAsJsonArray("target_cards")) {
                    final Card t = getGame().findById(e.getAsInt());
                    if (t != null && sa.canTarget(t)) {
                        sa.getTargets().add(t);
                    }
                }
            }
            if (r.has("target_players")) {
                for (JsonElement e : r.getAsJsonArray("target_players")) {
                    final Player t = e.getAsString().equals("you") ? player : player.getOpponents().getFirst();
                    if (t != null && sa.canTarget(t)) {
                        sa.getTargets().add(t);
                    }
                }
            }
            if (!sa.getTargets().isEmpty() && sa.isTargetNumberValid()) {
                return true;
            }
            sa.resetTargets();
            getAi().canPlaySa(sa); // Forge's AI fills in targets as it evaluates the play
            return !sa.getTargets().isEmpty() && sa.isTargetNumberValid();
        }

        /** The stack, top first, from the bot's point of view. */
        private JsonArray stack() {
            final JsonArray a = new JsonArray();
            for (SpellAbilityStackInstance si : getGame().getStack()) {
                final JsonObject o = new JsonObject();
                o.addProperty("controller", si.getActivatingPlayer() == player ? "you" : "opponent");
                o.addProperty("kind", si.isTrigger() ? "trigger" : si.isAbility() ? "ability" : "spell");
                if (si.getSourceCard() != null) {
                    o.addProperty("card_id", si.getSourceCard().getId());
                    o.addProperty("card", si.getSourceCard().getName());
                }
                o.addProperty("text", si.getStackDescription());
                final JsonArray targets = new JsonArray();
                if (si.getTargetChoices() != null) {
                    si.getTargetChoices().getTargetCards().forEach(c -> targets.add(c.getName() + " (id " + c.getId() + ")"));
                    si.getTargetChoices().getTargetPlayers().forEach(p -> targets.add(p == player ? "you" : "opponent"));
                }
                o.add("targets", targets);
                a.add(o);
            }
            return a;
        }

        private JsonObject option(int index, SpellAbility sa) {
            final JsonObject o = new JsonObject();
            o.addProperty("index", index);
            o.addProperty("card_id", sa.getHostCard().getId());
            o.addProperty("card", sa.getHostCard().getName());
            o.addProperty("kind", sa.isSpell() ? "spell" : "ability");
            o.addProperty("text", sa.getDescription());
            if (sa.usesTargeting()) {
                final JsonArray legal = new JsonArray();
                for (GameEntity t : sa.getTargetRestrictions().getAllCandidates(sa, true)) {
                    legal.add(t instanceof Player p ? (p == player ? "player: you" : "player: opponent")
                            : t.getName() + " (id " + t.getId() + ")");
                }
                o.add("legal_targets", legal);
            }
            return o;
        }

        private Set<Integer> ids(String key) {
            final Set<Integer> out = new HashSet<>();
            if (plan.has(key) && plan.get(key).isJsonArray()) {
                plan.getAsJsonArray(key).forEach(e -> out.add(e.getAsInt()));
            }
            return out;
        }

        private void say(JsonObject r, String prefix) {
            if (r.has("note") && !r.get("note").getAsString().isBlank()) {
                announce.accept(prefix + r.get("note").getAsString());
            }
        }

        private JsonObject state() {
            final JsonObject s = new JsonObject();
            s.addProperty("turn", getGame().getPhaseHandler().getTurn());
            s.add("you", side(player, true));
            final JsonArray opps = new JsonArray();
            player.getOpponents().forEach(o -> opps.add(side(o, false)));
            s.add("opponents", opps);
            return s;
        }
    }

    private static JsonObject side(Player p, boolean mine) {
        final JsonObject o = new JsonObject();
        o.addProperty("life", p.getLife());
        o.addProperty("library", p.getCardsIn(ZoneType.Library).size());
        o.addProperty("graveyard", p.getCardsIn(ZoneType.Graveyard).size());
        if (mine) {
            o.add("hand", cards(p, ZoneType.Hand));
        } else {
            o.addProperty("hand_size", p.getCardsIn(ZoneType.Hand).size());
        }
        o.add("command_zone", cards(p, ZoneType.Command));
        o.add("battlefield", cards(p, ZoneType.Battlefield));
        return o;
    }

    private static JsonArray cards(Player p, ZoneType zone) {
        final JsonArray a = new JsonArray();
        for (Card c : p.getCardsIn(zone)) {
            final JsonObject o = new JsonObject();
            o.addProperty("id", c.getId());
            o.addProperty("name", c.getName());
            if (c.isLand() && zone == ZoneType.Battlefield) {
                o.addProperty("tapped", c.isTapped());
                a.add(o);
                continue;
            }
            o.addProperty("type", c.getType().toString());
            if (c.getManaCost() != null && zone != ZoneType.Battlefield) {
                o.addProperty("cost", c.getManaCost().getShortString());
            }
            if (c.isCreature()) {
                o.addProperty("pt", c.getNetPower() + "/" + c.getNetToughness());
            }
            if (zone == ZoneType.Battlefield) {
                o.addProperty("tapped", c.isTapped());
                if (c.isCreature() && c.isSick()) {
                    o.addProperty("summoning_sick", true);
                }
            }
            o.addProperty("text", c.getOracleText());
            a.add(o);
        }
        return a;
    }
}
