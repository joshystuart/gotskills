# Registry identity vs Skill identity vs installation occupancy

Catalogue Skills are identified by stable Registry id plus folder name. Installation occupancy is identified separately by agent target plus folder name, with the supplying Registry recorded only as provenance. A GitHub owner/repository maps to at most one Registry; branch is an editable attribute of that Registry, not part of its identity.

This split is deliberate: same-name Skills from different Registries must remain visible as a Skill Conflict in the Catalogue, while only one Skill can occupy a given target folder. Collapsing either axis into the other would force silent shadowing or make cross-Registry installs impossible to reason about later.
