package orchestrator

import "testing"

func TestSlug(t *testing.T) {
	cases := []struct {
		name    string
		project string
		branch  string
		layout  string
		want    string
	}{
		{
			name:    "worktree layout sanitizes branch",
			project: "simplx",
			branch:  "feature/Orders_Refactor",
			layout:  "worktree",
			want:    "feature-orders-refactor",
		},
		{
			name:    "single layout uses project not branch",
			project: "simplx",
			branch:  "feature/Orders_Refactor",
			layout:  "single",
			want:    "simplx",
		},
		{
			name:    "collapses repeated separators",
			project: "simplx",
			branch:  "feat//weird___name",
			layout:  "worktree",
			want:    "feat-weird-name",
		},
		{
			name:    "trims leading and trailing dashes",
			project: "simplx",
			branch:  "/feature/foo/",
			layout:  "worktree",
			want:    "feature-foo",
		},
		{
			name:    "strips invalid characters",
			project: "simplx",
			branch:  "feat#foo!bar@baz",
			layout:  "worktree",
			want:    "featfoobarbaz",
		},
		{
			name:    "empty branch on worktree layout yields empty slug",
			project: "simplx",
			branch:  "",
			layout:  "worktree",
			want:    "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Slug(tc.project, tc.branch, tc.layout)
			if got != tc.want {
				t.Errorf("Slug(%q, %q, %q) = %q, want %q", tc.project, tc.branch, tc.layout, got, tc.want)
			}
		})
	}
}

func TestDomain(t *testing.T) {
	got := Domain("orders-refactor", "front", "simplx.localhost")
	want := "orders-refactor-front.simplx.localhost"
	if got != want {
		t.Errorf("Domain() = %q, want %q", got, want)
	}
}
