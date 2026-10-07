# Snowball English reference vocabulary

Source (BSD-3-Clause, notice in COPYING), from snowballstem/snowball-data, last changed in commit ca1919d3 (2025-10-28):

- https://raw.githubusercontent.com/snowballstem/snowball-data/master/english/voc.txt (42,649 words)
- https://raw.githubusercontent.com/snowballstem/snowball-data/master/english/output.txt (the stem of each word, line for line)
- https://raw.githubusercontent.com/snowballstem/snowball-data/master/COPYING

The two files are split losslessly to stay under the repository's 1,000-line file limit. voc/NAME.txt holds words and output/NAME.txt holds their stems, line for line. Line order within each group is preserved. Every word is in exactly one group, and together the groups are the whole list.

Words are grouped by first letter. A group over 700 lines (the review threshold) is split again by the next letter, repeatedly as needed. NAME is the prefix; an apostrophe in the prefix is written `_`, and `PREFIX-` holds the word that equals the prefix itself. Words that start with a non-letter are in `other`.
