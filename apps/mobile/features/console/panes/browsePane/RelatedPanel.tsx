import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { FocusRing } from "../../../design/components/FocusRing";
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
  files: Pick<FileBrowser, "relatedNotes" | "sync">;
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
      <Text variant="meta" aria-live="polite" testID="related-loading">
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
  const region = { role: "region", "aria-label": "Linked and related notes", testID: "related-panel" } as const;
  return bounded ? (
    <ScrollView style={[styles.panel, styles.bounded]} contentContainerStyle={styles.content} {...region}>
      {body}
    </ScrollView>
  ) : (
    <View style={[styles.panel, styles.content]} {...region}>
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
  const [focused, setFocused] = useState(false);
  const folder = parentPath(relation.path);
  const reasons = relation.reasons.map((reason) => REASON_WORDS[reason]).join(", ");
  return (
    <Pressable
      role="link"
      accessibilityLabel={`Open ${relation.path}`}
      onPress={() => onOpen(relation.path)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
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
      <FocusRing visible={focused} radius={radii.md} />
    </Pressable>
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
    pressed: { backgroundColor: colors.surface3 },
  });
