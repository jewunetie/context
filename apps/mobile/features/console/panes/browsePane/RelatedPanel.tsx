import { ScrollView, StyleSheet, View } from "react-native";
import { Button, PressRow } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { radii, space } from "../../../design/tokens";
import type { FileBrowser } from "../../files/browser";
import { REASON_WORDS, STATE_WORDS, type RelatedAnswer } from "../../files/browser/relatedAnswer";
import { baseName, displayName, displayPath, parentPath } from "../../files/paths";
import { useRelatedNotes } from "./useRelatedNotes";

type Relation = RelatedAnswer["relations"][number];

/**
 * "Linked here" and "Related" under the open note (link-graph Task 19, P7,
 * arch 14), and the note's own links that do not open.
 *
 * Authored backlinks (`links_here`) and everything derived are two groups,
 * because they are not one kind of fact. Unresolved links are this note's
 * only, where the person can fix them; there is no workspace-wide count.
 *
 * Every string from the answer is drawn as a `Text` child, so `evidence` (note
 * text, untrusted) is plain text and never markup.
 */
export function RelatedPanel({
  files,
  path,
  onOpen,
  bounded = false,
}: {
  files: Pick<FileBrowser, "relatedNotes" | "sync" | "editor">;
  path: string;
  onOpen: (path: string) => void;
  /**
   * A pointer layout: the editor above scrolls itself and this sits under it,
   * so it gets a height of its own and scrolls inside it rather than taking
   * the editor's. A phone's panel is part of the note's one scroller instead.
   */
  bounded?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { state, retry } = useRelatedNotes(files, path);
  if (state.kind === "hidden") return null;

  const body =
    state.kind === "offline" ? (
      <Text variant="meta" testID="related-offline">
        Linked and related notes need a connection.
      </Text>
    ) : state.kind === "loading" ? (
      <Text variant="meta" testID="related-loading">
        Finding linked and related notes…
      </Text>
    ) : state.kind === "unavailable" ? (
      <View style={styles.row} testID="related-unavailable">
        <Text variant="meta">Linked and related notes are unavailable right now.</Text>
        <Button label="Try again" onPress={retry} testID="related-retry" />
      </View>
    ) : (
      <Answer answer={state.answer} onOpen={onOpen} />
    );
  // Polite live region: what arrives (results, a failure, the incomplete notice) is announced.
  const region = {
    role: "region",
    "aria-label": "Linked and related notes",
    "aria-live": "polite",
    testID: "related-panel",
  } as const;
  // Level 2 under the note's own level 1 title; the groups below are level 3.
  const heading = (
    <Text variant="rowTitle" role="heading" aria-level={2}>
      Linked and related notes
    </Text>
  );
  return bounded ? (
    <ScrollView style={[styles.panel, styles.bounded]} contentContainerStyle={styles.content} {...region}>
      {heading}
      {body}
    </ScrollView>
  ) : (
    <View style={[styles.panel, styles.content]} {...region}>
      {heading}
      {body}
    </View>
  );
}

function Answer({ answer, onOpen }: { answer: RelatedAnswer; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const linked = answer.relations.filter((relation) => relation.reasons.includes("links_here"));
  const related = answer.relations.filter((relation) => !relation.reasons.includes("links_here"));
  const nothing = answer.relations.length === 0 && answer.unresolved.length === 0;

  return (
    <>
      {answer.possiblyIncomplete ? (
        <Text variant="hint" testID="related-incomplete">
          This may be incomplete: the link index has not finished reading this context.
        </Text>
      ) : nothing ? (
        <Text variant="meta" testID="related-empty">
          No linked or related notes.
        </Text>
      ) : null}
      <Group title="Linked here" relations={linked} onOpen={onOpen} testID="related-group-linked" />
      <Group title="Related" relations={related} onOpen={onOpen} testID="related-group-related" />
      {answer.unresolved.length === 0 ? null : (
        <View style={styles.group} testID="related-unresolved">
          <Text variant="listGroup" role="heading" aria-level={3}>
            Links that do not open
          </Text>
          {answer.unresolved.map((link) => (
            <Text key={`${link.start}:${link.end}`} variant="meta" testID="related-unresolved-row">
              <Text variant="mono">{link.target}</Text>
              {` · ${STATE_WORDS[link.state]}`}
            </Text>
          ))}
        </View>
      )}
    </>
  );
}

function Group({
  title,
  relations,
  onOpen,
  testID,
}: {
  title: string;
  relations: Relation[];
  onOpen: (path: string) => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  // An empty group is not drawn: "none" is the panel's claim to make, once, and only when complete.
  if (relations.length === 0) return null;
  return (
    <View style={styles.group} testID={testID}>
      <Text variant="listGroup" role="heading" aria-level={3}>
        {title}
      </Text>
      {relations.map((relation) => (
        <Row key={relation.path} relation={relation} onOpen={onOpen} />
      ))}
    </View>
  );
}

function Row({ relation, onOpen }: { relation: Relation; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const folder = parentPath(relation.path);
  const reasons = relation.reasons.map((reason) => REASON_WORDS[reason]).join(", ");
  // What a screen reader hears is what is drawn: the path, the reasons and the evidence.
  const label = [`Open ${relation.path}`, reasons, relation.evidence].filter((part) => part !== undefined).join(". ");
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={() => onOpen(relation.path)}
      style={styles.link}
      hoverStyle={styles.hover}
    >
      <Text variant="rowTitle" numberOfLines={1}>
        {displayName(baseName(relation.path))}
      </Text>
      <Text variant="rowSub" numberOfLines={1}>
        {folder === "" ? reasons : `${reasons} · ${displayPath(folder)}`}
      </Text>
      {relation.evidence === undefined ? null : (
        <Text variant="meta" numberOfLines={2}>
          {relation.evidence}
        </Text>
      )}
    </PressRow>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: {
      flexShrink: 0,
      marginTop: space.x4,
      paddingTop: space.x4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    bounded: { maxHeight: 280, flexShrink: 0 },
    content: { gap: space.x3 },
    row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    group: { gap: space.x1 },
    link: { paddingVertical: space.x1, paddingHorizontal: space.x2, marginHorizontal: -space.x2, borderRadius: radii.md },
    hover: { backgroundColor: colors.surface3 },
  });
