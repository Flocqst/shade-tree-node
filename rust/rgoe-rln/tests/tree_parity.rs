//! Cross-impl parity test (T-RUST-2c): the native Rust depth-20 Poseidon tree must
//! reproduce the rlnjs Semaphore-v3 group EXACTLY.
//!
//! The golden values below were emitted by the pinned JS reference libraries the
//! gateway actually uses (`poseidon-lite`, and rlnjs's nested
//! `@semaphore-protocol/group@3.15.2` via `lib/rln.mjs` `newGroup`), over the same
//! ordered member lists. Regenerate with:
//!
//! ```text
//! node --input-type=module -e '
//!   import { poseidon2 } from "poseidon-lite";
//!   import { newGroup, rateCommitmentOf, identityFor } from "./lib/rln.mjs";
//!   const g = newGroup([111n,222n,333n]);
//!   console.log(g.root.toString(), JSON.stringify(g.generateMerkleProof(1).siblings.map(String)));
//! '
//! ```
//!
//! Group id / RLN identifier is 1 (RGOE_RLN_IDENTIFIER default), tree depth 20.

use ark_bn254::Fr;
use num_bigint::BigUint;
use rgoe_rln::tree::{dec_to_fr, fr_to_dec, poseidon2, MerkleTree, TREE_DEPTH};

fn id1() -> BigUint {
    BigUint::from(1u8)
}

#[test]
fn poseidon2_matches_poseidon_lite() {
    assert_eq!(
        fr_to_dec(&poseidon2(Fr::from(1u8), Fr::from(2u8))),
        "7853200120776062878684798364095072458815029376092732009249414926327459813530",
        "poseidon2([1,2]) must match poseidon-lite"
    );
    assert_eq!(
        fr_to_dec(&poseidon2(Fr::from(0u8), Fr::from(0u8))),
        "14744269619966411208579211824598458697587494354926760081771325075741142829156",
        "poseidon2([0,0]) must match poseidon-lite"
    );
}

#[test]
fn zeroes_chain_matches_semaphore_group() {
    // Zero value = keccak(be32(id)) >> 8, then poseidon2(z,z) up the levels.
    let tree = MerkleTree::new(&id1(), TREE_DEPTH, &[Fr::from(111u8)]);
    let z = tree.zeroes();
    assert_eq!(
        fr_to_dec(&z[0]),
        "312829776796408387545637016147278514583116203736587368460269838669765409292",
        "zeroes[0] = hash(id=1)"
    );
    assert_eq!(
        fr_to_dec(&z[1]),
        "17535619402286407081295631767513211308680675749569186355146809059232187698717",
        "zeroes[1] = poseidon2(z0,z0)"
    );
    assert_eq!(
        fr_to_dec(&z[2]),
        "1477631603177773802461491883360377632354482817337831845500543337070103200031",
        "zeroes[2] = poseidon2(z1,z1)"
    );
}

#[test]
fn empty_tree_root_matches() {
    let tree = MerkleTree::new(&id1(), TREE_DEPTH, &[]);
    assert_eq!(
        fr_to_dec(&tree.root()),
        "10354334201938752428558948798274962999644820234654929486063894213598717249307",
        "empty depth-20 group root"
    );
}

#[test]
fn single_member_root_and_path_match() {
    // leaf = rateCommitmentOf(identityFor("12345678901234567890")) from lib/rln.mjs.
    let leaf =
        dec_to_fr("21558879520918633596307886395806128284829934557451023090307161200586948687467");
    let tree = MerkleTree::new(&id1(), TREE_DEPTH, &[leaf]);
    assert_eq!(
        fr_to_dec(&tree.root()),
        "3785682313467071579255743317800791903575024828800550883853752229841189042428",
        "single-member rlnjs group root"
    );

    let (siblings, path_indices) = tree.create_proof(0);
    assert_eq!(siblings.len(), TREE_DEPTH);
    assert_eq!(
        path_indices,
        vec![0u8; TREE_DEPTH],
        "index-0 path is all-left"
    );
    // For the single member the siblings are exactly the empty-subtree zeroes.
    for (level, sib) in siblings.iter().enumerate() {
        assert_eq!(
            fr_to_dec(sib),
            fr_to_dec(&tree.zeroes()[level]),
            "single-member sibling[{level}] must equal zeroes[{level}]"
        );
    }
}

#[test]
fn three_member_root_and_path_match() {
    let leaves = [Fr::from(111u8), Fr::from(222u16), Fr::from(333u16)];
    let tree = MerkleTree::new(&id1(), TREE_DEPTH, &leaves);
    assert_eq!(
        fr_to_dec(&tree.root()),
        "15969843931226098728940239815130512524610801129032957101670597998799580369298",
        "3-member (111,222,333) rlnjs group root"
    );

    // Proof for member at index 1 exercises a REAL leaf sibling + a REAL internal node.
    let (siblings, path_indices) = tree.create_proof(1);
    assert_eq!(
        path_indices,
        {
            let mut p = vec![0u8; TREE_DEPTH];
            p[0] = 1;
            p
        },
        "index-1 path: right at level 0, left above"
    );
    let want_siblings = [
        "111",
        "20085277064241499442112716745470920011835352726801469983047104633763027187344",
        "1477631603177773802461491883360377632354482817337831845500543337070103200031",
    ];
    for (i, want) in want_siblings.iter().enumerate() {
        assert_eq!(
            fr_to_dec(&siblings[i]),
            *want,
            "3-member idx1 sibling[{i}] mismatch vs rlnjs"
        );
    }
}
